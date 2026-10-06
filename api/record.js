// GET /api/record?sport=nfl|cfb|mlb  -> how the app's locked picks have done, and what it has learned.
const track = require('../lib/track');
const store = require('../lib/store');

const wlp = () => ({ W: 0, L: 0, P: 0 });
const add = (o, r) => { if (r && o[r] != null) o[r]++; };
const pct = (o) => (o.W + o.L ? Math.round((1000 * o.W) / (o.W + o.L)) / 10 : null);

function footballSummary(rec) {
  const games = Object.values(rec.games);
  const graded = games.filter((g) => g.result).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const spread = { all: wlp(), Strong: wlp(), Solid: wlp(), Lean: wlp() };
  const total = { all: wlp(), Strong: wlp(), Solid: wlp(), Lean: wlp() };
  const winner = wlp();
  const buckets = [[0, 20], [20, 35], [35, 50], [50, 101]].map(([a, b]) => ({ label: a === 50 ? '50%+' : `${a}-${b}%`, a, b, n: 0, pred: 0, act: 0 }));
  const yds = { rush: { n: 0, proj: 0, act: 0 }, rec: { n: 0, proj: 0, act: 0 }, pass: { n: 0, proj: 0, act: 0 } };
  for (const g of graded) {
    const r = g.result;
    if (g.spread) { add(spread.all, r.spread); add(spread[g.spread.conf], r.spread); }
    if (g.total) { add(total.all, r.total_); add(total[g.total.conf], r.total_); }
    add(winner, r.winner);
    const res = {}; (r.players || []).forEach((x) => { res[x.id] = x; });
    (g.players || []).forEach((p) => {
      const a = res[p.id]; if (!a || !a.played) return;
      const b = buckets.find((k) => p.td >= k.a && p.td < k.b);
      if (b && p.td >= 8) { b.n++; b.pred += p.td; b.act += a.td; }
      if (p.ry >= 15 && p.pos !== 'QB') { yds.rush.n++; yds.rush.proj += p.ry; yds.rush.act += a.ry; }
      if (p.cy >= 15) { yds.rec.n++; yds.rec.proj += p.cy; yds.rec.act += a.cy; }
      if (p.pos === 'QB' && p.py > 0) { yds.pass.n++; yds.pass.proj += p.py; yds.pass.act += a.py; }
    });
  }
  Object.values(spread).concat(Object.values(total)).forEach((o) => { o.pct = pct(o); });
  winner.pct = pct(winner);
  return {
    graded: graded.length, pending: games.length - graded.length,
    spread, total, winner,
    td: buckets.filter((b) => b.n).map((b) => ({ label: b.label, n: b.n, predicted: Math.round(b.pred / b.n), actual: Math.round((100 * b.act) / b.n) })),
    yards: Object.fromEntries(Object.entries(yds).map(([k, v]) => [k, v.n ? { n: v.n, proj: Math.round(v.proj / v.n), actual: Math.round(v.act / v.n) } : null])),
    recent: graded.slice(0, 25).map((g) => ({
      date: g.date, week: g.week, away: g.away.ab, home: g.home.ab, score: `${g.away.ab} ${g.result.away} – ${g.home.ab} ${g.result.home}`,
      spread: g.spread ? { label: g.spread.label, conf: g.spread.conf, result: g.result.spread } : null,
      total: g.total ? { label: g.total.label, conf: g.total.conf, result: g.result.total_ } : null
    })),
    upcoming: games.filter((g) => !g.result).sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(0, 20)
      .map((g) => ({ date: g.date, away: g.away.ab, home: g.home.ab, spread: g.spread && g.spread.label, conf: g.spread && g.spread.conf, total: g.total && g.total.label, lockedAt: g.lockedAt }))
  };
}

function mlbSummary(rec) {
  const games = Object.values(rec.games);
  const graded = games.filter((g) => g.result && !g.result.void);
  const all = { n: 0, hits: 0, pred: 0 }, top = { n: 0, hits: 0, pred: 0 };
  const buckets = [[0, 55], [55, 65], [65, 75], [75, 101]].map(([a, b]) => ({ label: a === 75 ? '75%+' : a === 0 ? 'Under 55%' : `${a}-${b}%`, a, b, n: 0, pred: 0, act: 0 }));
  const days = {};
  for (const g of graded) {
    const r = {}; (g.result.hitters || []).forEach((h) => { r[h.id] = h; });
    g.hitters.forEach((h) => {
      const a = r[h.id]; if (!a || a.void) return;
      all.n++; all.hits += a.hit; all.pred += h.chance;
      const b = buckets.find((k) => h.chance >= k.a && h.chance < k.b); if (b) { b.n++; b.pred += h.chance; b.act += a.hit; }
      (days[g.date] = days[g.date] || []).push({ n: h.n, team: h.team, chance: h.chance, hit: a.hit, h: a.h, pa: a.pa });
    });
  }
  const dayList = Object.entries(days).sort((a, b) => b[0].localeCompare(a[0])).map(([d, xs]) => {
    const t = xs.sort((a, b) => b.chance - a.chance).slice(0, 10);
    t.forEach((x) => { top.n++; top.hits += x.hit; top.pred += x.chance; });
    return { date: d, top10: t.reduce((a, x) => a + x.hit, 0), of: t.length, picks: t };
  });
  const fin = (o) => (o.n ? { n: o.n, hits: o.hits, rate: Math.round((1000 * o.hits) / o.n) / 10, predicted: Math.round((10 * o.pred) / o.n) / 10 } : null);
  return {
    graded: graded.length, pending: games.filter((g) => !g.result).length,
    all: fin(all), top10: fin(top),
    buckets: buckets.filter((b) => b.n).map((b) => ({ label: b.label, n: b.n, predicted: Math.round(b.pred / b.n), actual: Math.round((100 * b.act) / b.n) })),
    days: dayList.slice(0, 14)
  };
}

module.exports = async function handler(req, res) {
  const sport = ['nfl', 'cfb', 'mlb'].includes(req.query && req.query.sport) ? req.query.sport : 'nfl';
  if (!store.enabled()) return res.status(200).json({ sport, tracking: false });
  try {
    const now = new Date();
    let season = now.getFullYear();
    if (sport !== 'mlb' && now.getMonth() < 6) season -= 1; // football seasons run into the next year
    const rec = await track.loadRec(sport, season);
    const calib = (await store.readJSON('calib.json')) || {};
    const body = sport === 'mlb' ? mlbSummary(rec) : footballSummary(rec);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json({ sport, season, tracking: true, learned: calib[sport] || {}, learnedAt: calib.updated || null, ...body });
  } catch (err) {
    res.status(502).json({ error: 'Could not load the record right now.', detail: String((err && err.message) || err) });
  }
};
