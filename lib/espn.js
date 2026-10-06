// ESPN public football data: scoreboards, box scores, rosters.
// Turns each finished game into a small record the model can use.

const BASE = {
  nfl: 'https://site.api.espn.com/apis/site/v2/sports/football/nfl',
  cfb: 'https://site.api.espn.com/apis/site/v2/sports/football/college-football'
};

async function getJSON(url, tries = 2) {
  let err;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'HitFinder/1.0 (personal project)' } });
      if (!r.ok) throw new Error('ESPN returned ' + r.status);
      return await r.json();
    } catch (e) { err = e; }
  }
  throw err;
}

// Run async jobs with a cap on how many are in flight.
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } }
  }));
  return out;
}

function scoreboardURL(lg, q = {}) {
  const p = new URLSearchParams();
  if (lg === 'cfb') { p.set('groups', '80'); p.set('limit', '300'); }
  if (q.week) p.set('week', q.week);
  if (q.seasontype) p.set('seasontype', q.seasontype);
  if (q.year) p.set('dates', q.year);
  return BASE[lg] + '/scoreboard' + (p.toString() ? '?' + p : '');
}
const scoreboard = (lg, q) => getJSON(scoreboardURL(lg, q));

// The week to show: ESPN's default, or the next one once every game is final.
async function currentSlate(lg) {
  let sb = await scoreboard(lg);
  const done = (sb.events || []).length && sb.events.every((e) => e.status && e.status.type && e.status.type.completed);
  if (done && sb.week && sb.week.number) {
    try {
      const nx = await scoreboard(lg, { week: sb.week.number + 1, seasontype: sb.season && sb.season.type, year: sb.season && sb.season.year });
      if ((nx.events || []).length) sb = nx;
    } catch (e) { /* keep current */ }
  }
  return sb;
}

// ---------- names ----------
const SUFFIX = /\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i;
const norm = (s) => String(s || '').toLowerCase().replace(SUFFIX, '').replace(/[^a-z]/g, '');
function nameKeys(full, short) {
  const n = String(full || '').replace(SUFFIX, '').trim();
  const parts = n.split(/\s+/);
  const first = parts[0] || '', last = parts.slice(1).join(' ');
  const keys = new Set([norm(n), norm(first[0] + last), norm(first.slice(0, 2) + last), norm(first.slice(0, 3) + last)]);
  if (short) keys.add(norm(short));
  return keys;
}
const NAME = "([A-Z][A-Za-z'\\.\\-]*(?:\\s(?:[A-Z][A-Za-z'\\.\\-]*|Jr\\.?|Sr\\.?|II|III|IV))*)";
const RE_TARGET = new RegExp('pass (?:[a-z]+ )*?(?:to|intended for) (?:#\\d+ )?' + NAME);
const RE_RUSH = new RegExp('^(?:#\\d+ )?' + NAME + '(?= (?:rush|run|up the|left|right|middle|scrambles|kneels|sneak|for |to the))');

function cleanLead(text) {
  let t = String(text || '');
  t = t.replace(/^.*?reported in as eligible\.?\s*/i, '');
  for (let i = 0; i < 4; i++) t = t.replace(/^\s*\([^)]*\)\s*/, '');
  t = t.replace(/^(?:No Huddle-Shotgun|No Huddle|Shotgun|Pistol|Under Center)\s+/i, '');
  return t.replace(/^\s*\([^)]*\)\s*/, '');
}

// ---------- one finished game -> compact record ----------
function compactGame(s, lg) {
  const comp = s.header && s.header.competitions && s.header.competitions[0];
  if (!comp) return null;
  const tm = comp.competitors.map((c) => ({ id: String(c.team.id), ab: c.team.abbreviation, score: +c.score || 0, home: c.homeAway === 'home' }));
  const home = tm.find((x) => x.home), away = tm.find((x) => !x.home);
  const num = (x) => parseFloat(x) || 0;
  const teams = {};
  ((s.boxscore && s.boxscore.teams) || []).forEach((bt) => {
    const st = {}; (bt.statistics || []).forEach((x) => { st[x.name] = x.displayValue; });
    const ca = String(st.completionAttempts || '0/0').split(/[\/-]/);
    const rz = String(st.redZoneAttempts || '').split('-');
    const t3 = String(st.thirdDownEff || '0-0').split('-');
    const passAtt = num(ca[1]), rushAtt = num(st.rushingAttempts);
    teams[String(bt.team.id)] = {
      plays: num(st.totalOffensivePlays) || passAtt + rushAtt, yds: num(st.totalYards),
      passAtt, rushAtt, rushYds: num(st.rushingYards), passYds: num(st.netPassingYards),
      to: num(st.turnovers), rzA: rz.length === 2 ? num(rz[1]) : null, rzTD: rz.length === 2 ? num(rz[0]) : null,
      t3c: num(t3[0]), t3a: num(t3[1])
    };
  });
  const P = {};
  let tgtKnown = false;
  ((s.boxscore && s.boxscore.players) || []).forEach((bp) => {
    const tid = String(bp.team.id);
    (bp.statistics || []).forEach((c) => {
      if (!['passing', 'rushing', 'receiving'].includes(c.name)) return;
      const L = c.labels || [];
      const at = (v, lab) => { const i = L.indexOf(lab); return i < 0 ? 0 : num(v[i]); };
      (c.athletes || []).forEach((a) => {
        const ath = a.athlete || {};
        const id = String(ath.id);
        const p = P[id] || (P[id] = { id, n: ath.displayName, sn: ath.shortName || '', t: tid, pos: (ath.position && ath.position.abbreviation) || '', car: 0, ry: 0, rtd: 0, rec: 0, tgt: 0, recy: 0, retd: 0, att: 0, cmp: 0, py: 0, ptd: 0, int: 0, rz: 0, rz10: 0, gl: 0 });
        const v = a.stats || [];
        if (c.name === 'rushing') { p.car = at(v, 'CAR'); p.ry = at(v, 'YDS'); p.rtd = at(v, 'TD'); }
        if (c.name === 'receiving') {
          p.rec = at(v, 'REC'); p.recy = at(v, 'YDS'); p.retd = at(v, 'TD');
          if (L.includes('TGTS')) { p.tgt = at(v, 'TGTS'); tgtKnown = true; } else p.tgt = Math.round(p.rec * 1.45);
        }
        if (c.name === 'passing') {
          const i = L.indexOf('C/ATT'); const ca = String(v[i] || '0/0').split('/');
          p.cmp = num(ca[0]); p.att = num(ca[1]); p.py = at(v, 'YDS'); p.ptd = at(v, 'TD'); p.int = at(v, 'INT');
        }
      });
    });
  });
  // red zone touches from play-by-play
  const byTeam = {};
  Object.values(P).forEach((p) => { (byTeam[p.t] = byTeam[p.t] || []).push({ p, keys: nameKeys(p.n, p.sn) }); });
  const find = (tid, raw) => {
    const k = norm(raw);
    const list = byTeam[tid] || [];
    return (list.find((x) => x.keys.has(k)) || list.find((x) => [...x.keys].some((kk) => kk.length > 3 && (kk.startsWith(k) || k.startsWith(kk)))) || {}).p;
  };
  let rzPlays = 0, rzHits = 0;
  ((s.drives && s.drives.previous) || []).forEach((d) => (d.plays || []).forEach((pl) => {
    const ytg = pl.start && pl.start.yardsToEndzone;
    if (ytg == null || ytg > 20) return;
    const tx = String(pl.text || '');
    if (/NO PLAY/.test(tx)) return;
    const tid = pl.start && pl.start.team && String(pl.start.team.id);
    const type = (pl.type && pl.type.text) || '';
    let who = null, kind = null, m;
    if (/pass/i.test(tx) && !/sacked/i.test(tx) && (m = tx.match(RE_TARGET))) { who = m[1]; kind = 't'; }
    else if (/Rush/.test(type) && (m = cleanLead(tx).match(RE_RUSH))) { who = m[1]; kind = 'c'; }
    if (who) who = who.replace(/\.(?:PENALTY|[A-Z]{3,}).*$/, '');
    if (!who || !tid) return;
    rzPlays++;
    const p = find(tid, who);
    if (!p) return;
    rzHits++;
    p.rz++; if (ytg <= 10) p.rz10++; if (ytg <= 5 && kind === 'c') p.gl++;
  }));
  const status = comp.status && comp.status.type;
  return {
    id: String(comp.id || (s.header && s.header.id)), date: comp.date, lg,
    neutral: !!comp.neutralSite, completed: !!(status && status.completed),
    home: { id: home.id, ab: home.ab, score: home.score }, away: { id: away.id, ab: away.ab, score: away.score },
    teams, tgtKnown, rzMatch: rzPlays ? +(rzHits / rzPlays).toFixed(2) : null,
    players: Object.values(P).map(({ sn, ...rest }) => rest)
  };
}

async function gameSummary(lg, id) { return getJSON(BASE[lg] + '/summary?event=' + id); }

// NFL injury report and positions from team rosters.
async function rosters(lg, teamIds) {
  const out = {};
  await pool(teamIds, 8, async (id) => {
    const j = await getJSON(BASE[lg] + '/teams/' + id + '/roster');
    (j.athletes || []).forEach((g) => (g.items || [g]).forEach((a) => {
      if (!a || !a.id) return;
      out[String(a.id)] = { pos: (a.position && a.position.abbreviation) || '', inj: (a.injuries || []).map((i) => i.status).filter(Boolean)[0] || '', team: String(id) };
    }));
  });
  return out;
}

// FBS team ids for a season (everyone else is lumped together as FCS).
async function fbsTeamIds(season) {
  const j = await getJSON('https://sports.core.api.espn.com/v2/sports/football/leagues/college-football/seasons/' + season + '/types/2/groups/80/teams?limit=300');
  return (j.items || []).map((x) => (String(x.$ref || '').match(/\/teams\/(\d+)/) || [])[1]).filter(Boolean);
}

module.exports = { BASE, getJSON, pool, scoreboard, currentSlate, gameSummary, compactGame, rosters, fbsTeamIds, nameKeys, norm };
