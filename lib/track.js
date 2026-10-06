// Pick tracking: lock picks before games, grade them after, and learn small corrections.
const store = require('./store');
const fbdata = require('./fbdata');
const espn = require('./espn');
const mlb = require('../api/slate');

const MLB = 'https://statsapi.mlb.com/api/v1';
const recPath = (sport, season) => `record/${sport}-${season}.json`;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// Eastern-time pieces for a timestamp
function et(d) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hour12: false })
    .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, hour: +p.hour % 24 };
}
const addDays = (ymd, n) => { const t = new Date(ymd + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };

// Should a game starting at `start` be locked by this run?
function inWindow(start, job, now = Date.now()) {
  const s = Date.parse(start);
  if (!(s > now)) return false; // already started
  const today = et(now).ymd, g = et(s);
  if (job === 'morning') return g.ymd === today && g.hour < 18;
  if (job === 'evening') return (g.ymd === today) || (g.ymd === addDays(today, 1) && g.hour < 10);
  return g.ymd === today || (g.ymd === addDays(today, 1) && g.hour < 10); // manual run
}

async function loadRec(sport, season) {
  return (await store.readJSON(recPath(sport, season))) || { sport, season, games: {} };
}

// ---------------- football ----------------
async function lockFootball(lg, job, log) {
  const sl = await fbdata.slate(lg, { refresh: false });
  const rec = await loadRec(lg, sl.season);
  let n = 0;
  for (const g of sl.games) {
    if (rec.games[g.id] || g.state !== 'pre' || !inWindow(g.date, job)) continue;
    rec.games[g.id] = {
      id: g.id, date: g.date, week: sl.week, lockedAt: new Date().toISOString(),
      away: { id: g.away.id, ab: g.away.ab, rank: g.away.rank }, home: { id: g.home.id, ab: g.home.ab, rank: g.home.rank },
      line: g.line, spread: g.spread, total: g.total,
      winner: { ab: g.proj.winner, pct: g.proj.winPct },
      proj: { margin: g.proj.margin, total: g.proj.total, rawMargin: g.proj.rawMargin, rawTotal: g.proj.rawTotal },
      players: g.allPlayers, result: null
    };
    n++;
  }
  if (n) await store.writeJSON(recPath(lg, sl.season), rec);
  log.push(`${lg}: locked ${n} games`);
  return sl.season;
}

async function gradeFootball(lg, log) {
  // refresh the season's finished games first (the picks below also use them)
  const sb = await espn.currentSlate(lg);
  const { data, info } = await fbdata.loadGames(lg, sb, { refresh: true });
  const season = info.season;
  const rec = await loadRec(lg, season);
  const open = Object.values(rec.games).filter((x) => !x.result && Date.parse(x.date) < Date.now() - 3 * 3600e3);
  let n = 0;
  for (const L of open) {
    const g = data.games[L.id];
    if (!g || !g.completed) continue;
    const hs = g.home.score, as = g.away.score, margin = hs - as;
    const res = { home: hs, away: as, margin, total: hs + as };
    if (L.spread) {
      const pickHome = L.spread.teamId === L.home.id;
      const d = (pickHome ? margin : -margin) + L.spread.line;
      res.spread = d > 0 ? 'W' : d < 0 ? 'L' : 'P';
    }
    if (L.total) { const d = res.total - L.total.line; res.total_ = d === 0 ? 'P' : (d > 0) === (L.total.side === 'Over') ? 'W' : 'L'; }
    res.winner = (margin > 0 ? L.home.ab : margin < 0 ? L.away.ab : '') === L.winner.ab ? 'W' : margin === 0 ? 'P' : 'L';
    if (L.line && L.line.sp != null) { res.errModel = Math.abs(L.proj.rawMargin - margin); res.errVegas = Math.abs(-L.line.sp - margin); }
    const act = {};
    g.players.forEach((p) => { act[p.id] = p; });
    res.players = (L.players || []).map((p) => {
      const a = act[p.id];
      if (!a) return { id: p.id, played: false };
      return { id: p.id, played: true, td: a.rtd + a.retd > 0 ? 1 : 0, ry: a.ry, cy: a.recy, py: a.py };
    });
    L.result = res; n++;
  }
  if (n) await store.writeJSON(recPath(lg, season), rec);
  log.push(`${lg}: graded ${n} games`);
  return { rec, season };
}

// ---------------- baseball ----------------
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'HitFinder/1.0 (personal project)' } });
  if (!r.ok) throw new Error('MLB ' + r.status);
  return r.json();
}

async function lockMLB(job, log) {
  const today = et(Date.now()).ymd;
  const dates = job === 'morning' ? [today] : [today, addDays(today, 1)];
  let n = 0, season = today.slice(0, 4);
  const rec = await loadRec('mlb', season);
  for (const d of dates) {
    const sl = await mlb.buildSlate(d);
    for (const g of sl.games || []) {
      if (rec.games[g.id] || g.live || g.final || !inWindow(g.start, job)) continue;
      const hitters = [];
      g.sides.forEach((s, k) => (s.hitters || []).forEach((h) => hitters.push({
        id: h.id, n: h.name, team: s.team.abbr, chance: h.chance, raw: h.rawChance, perPa: h.perPa, expPa: h.expPa, slot: h.slot, projected: !!s.projected,
        vs: s.pitcher && s.pitcher.name
      })));
      if (!hitters.length) continue;
      rec.games[g.id] = { id: g.id, date: d, start: g.start, lockedAt: new Date().toISOString(), away: g.away.abbr, home: g.home.abbr, desc: g.desc, hitters, result: null };
      n++;
    }
  }
  if (n) await store.writeJSON(recPath('mlb', season), rec);
  log.push(`mlb: locked ${n} games`);
  return season;
}

async function gradeMLB(season, log) {
  const rec = await loadRec('mlb', season);
  const open = Object.values(rec.games).filter((x) => !x.result && Date.parse(x.start) < Date.now() - 2.5 * 3600e3);
  let n = 0;
  const byDate = {};
  open.forEach((x) => { (byDate[x.date] = byDate[x.date] || []).push(x); });
  for (const [d, list] of Object.entries(byDate)) {
    const sched = await getJSON(`${MLB}/schedule?sportId=1&date=${d}`);
    const st = {};
    ((sched.dates && sched.dates[0] && sched.dates[0].games) || []).forEach((g) => { st[g.gamePk] = g.status; });
    for (const L of list) {
      const s = st[L.id];
      if (!s) continue;
      if (/Postponed|Cancelled|Suspended/i.test(s.detailedState || '')) { L.result = { void: true, reason: s.detailedState }; n++; continue; }
      if (s.abstractGameState !== 'Final') continue;
      const box = await getJSON(`${MLB}/game/${L.id}/boxscore`);
      const stat = {};
      ['away', 'home'].forEach((k) => Object.values((box.teams && box.teams[k] && box.teams[k].players) || {}).forEach((p) => {
        const b = p.stats && p.stats.batting; if (b) stat[p.person.id] = { h: +b.hits || 0, pa: +b.plateAppearances || 0 };
      }));
      L.result = { hitters: L.hitters.map((h) => { const b = stat[h.id]; return b && b.pa > 0 ? { id: h.id, hit: b.h > 0 ? 1 : 0, h: b.h, pa: b.pa } : { id: h.id, void: true }; }) };
      n++;
    }
  }
  if (n) await store.writeJSON(recPath('mlb', season), rec);
  log.push(`mlb: graded ${n} games`);
  return rec;
}

// ---------------- learning ----------------
function learnFootball(rec, prev) {
  const graded = Object.values(rec.games).filter((x) => x.result && !x.result.void);
  const out = { games: graded.length };
  // TD: find k so predicted anytime-TD rate matches what actually happened
  const pts = [];
  graded.forEach((g) => { const res = {}; (g.result.players || []).forEach((r) => { res[r.id] = r; }); (g.players || []).forEach((p) => { const r = res[p.id]; if (r && r.played && p.lr > 0) pts.push({ l: p.lr, td: r.td, p, r }); }); });
  out.tdSample = pts.length;
  if (pts.length >= 300) {
    const actual = pts.reduce((a, x) => a + x.td, 0);
    let lo = 0.5, hi = 2;
    for (let i = 0; i < 40; i++) { const k = (lo + hi) / 2; const pred = pts.reduce((a, x) => a + 1 - Math.exp(-k * x.l), 0); if (pred > actual) hi = k; else lo = k; }
    out.tdMult = +clamp((lo + hi) / 2, 0.7, 1.4).toFixed(3);
  }
  const yd = {};
  [['rush', 'ryr', 'ry'], ['rec', 'cyr', 'cy'], ['pass', 'pyr', 'py']].forEach(([k, pf, af]) => {
    const xs = pts.filter((x) => x.p[pf] >= 15);
    if (xs.length >= 100) yd[k] = +clamp(xs.reduce((a, x) => a + x.r[af], 0) / xs.reduce((a, x) => a + x.p[pf], 0), 0.85, 1.15).toFixed(3);
  });
  if (Object.keys(yd).length) out.ydsMult = yd;
  const withLine = graded.filter((g) => g.result.errModel != null);
  out.lineSample = withLine.length;
  if (withLine.length >= 40) {
    const mm = withLine.reduce((a, g) => a + g.result.errModel, 0) / withLine.length;
    const mv = withLine.reduce((a, g) => a + g.result.errVegas, 0) / withLine.length;
    out.trust = +clamp(Math.pow(mv / mm, 3), 0.5, 1.5).toFixed(3);
    out.modelErr = +mm.toFixed(2); out.vegasErr = +mv.toFixed(2);
  }
  return out;
}

function learnMLB(rec) {
  const xs = [];
  Object.values(rec.games).forEach((g) => { if (!g.result || g.result.void) return; const r = {}; (g.result.hitters || []).forEach((h) => { r[h.id] = h; }); g.hitters.forEach((h) => { const a = r[h.id]; if (a && !a.void && h.raw) xs.push({ raw: h.raw, hit: a.hit }); }); });
  const out = { sample: xs.length };
  const recent = xs.slice(-4000);
  if (recent.length >= 300) {
    const ratio = recent.reduce((a, x) => a + x.hit, 0) / recent.reduce((a, x) => a + x.raw, 0);
    // a 1% change in per-PA rate moves the game chance by about 0.7%
    out.chanceRatio = +ratio.toFixed(3);
    out.pMult = +clamp(1 + (ratio - 1) / 0.7, 0.8, 1.2).toFixed(3);
  }
  return out;
}

async function run(job) {
  const log = [];
  if (!store.enabled()) return { ok: false, log: ['Storage is not connected, so nothing can be tracked yet.'] };
  const calib = (await store.readJSON('calib.json')) || {};
  const step = async (name, fn) => { try { return await fn(); } catch (e) { log.push(`${name} failed: ${(e && e.message) || e}`); return null; } };
  // 1. grade finished games and learn from them
  for (const lg of ['nfl', 'cfb']) {
    const gr = await step(lg + ' grade', () => gradeFootball(lg, log));
    if (gr) calib[lg] = learnFootball(gr.rec, calib[lg]);
  }
  const mrec = await step('mlb grade', () => gradeMLB(String(new Date().getFullYear()), log));
  if (mrec) calib.mlb = learnMLB(mrec);
  calib.updated = new Date().toISOString();
  await store.writeJSON('calib.json', calib);
  // 2. lock upcoming picks (these now use what was just learned)
  for (const lg of ['nfl', 'cfb']) await step(lg + ' lock', () => lockFootball(lg, job, log));
  await step('mlb lock', () => lockMLB(job, log));
  return { ok: true, log, calib };
}

module.exports = { run, loadRec, recPath, et, inWindow };
