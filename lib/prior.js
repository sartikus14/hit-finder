// Last season's final team ratings, used as a starting point that fades out as this season's games pile up.
const espn = require('./espn');
const store = require('./store');

const HFA = { nfl: 1.7, cfb: 2.7 };
const CAP = { nfl: 17, cfb: 24 };
const softCap = (m, X) => { const a = Math.abs(m); return Math.sign(m) * (a <= X ? a : X + 0.3 * (a - X)); };

async function build(lg, season, fbs) {
  const weeks = [];
  const reg = lg === 'nfl' ? 18 : 16;
  for (let w = 1; w <= reg; w++) weeks.push({ week: w, seasontype: 2 });
  for (let w = 1; w <= 5; w++) weeks.push({ week: w, seasontype: 3 });
  const games = [];
  await espn.pool(weeks, 6, async (x) => {
    const sb = await espn.scoreboard(lg, { week: x.week, seasontype: x.seasontype, year: season });
    (sb.events || []).forEach((e) => {
      if (!(e.status && e.status.type && e.status.type.completed)) return;
      const c = e.competitions[0];
      const h = c.competitors.find((t) => t.homeAway === 'home'), a = c.competitors.find((t) => t.homeAway === 'away');
      games.push({ h: String(h.team.id), a: String(a.team.id), hs: +h.score || 0, as: +a.score || 0, neutral: !!c.neutralSite });
    });
  });
  const key = (id) => (lg !== 'cfb' || !fbs || fbs.has(id) ? id : 'FCS');
  const G = {};
  games.forEach((g) => {
    [[key(g.h), key(g.a), g.hs, g.as, g.neutral ? 0 : 1], [key(g.a), key(g.h), g.as, g.hs, g.neutral ? 0 : -1]].forEach(([me, op, pf, pa, home]) => {
      (G[me] = G[me] || []).push({ op, pf, pa, home });
    });
  });
  const ids = Object.keys(G);
  const all = games.length ? games.reduce((s, g) => s + g.hs + g.as, 0) / (2 * games.length) : 0;
  const r = {}, po = {}, pd = {};
  ids.forEach((id) => { r[id] = 0; po[id] = 0; pd[id] = 0; });
  for (let it = 0; it < 60; it++) {
    ids.forEach((id) => {
      let s1 = 0, s2 = 0, s3 = 0;
      G[id].forEach((g) => {
        s1 += softCap(g.pf - g.pa, CAP[lg]) - g.home * HFA[lg] + r[g.op];
        s2 += g.pf - all - pd[g.op];
        s3 += g.pa - all - po[g.op];
      });
      const n = G[id].length + 2;
      r[id] = s1 / n; po[id] = s2 / n; pd[id] = s3 / n;
    });
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 10) / 10]));
  return { lg, season, games: games.length, built: new Date().toISOString(), r: round(r), po: round(po), pd: round(pd) };
}

const mem = {};
async function load(lg, season, fbs) {
  const k = lg + season;
  if (mem[k]) return mem[k];
  const path = `fb/prior-${lg}-${season}.json`;
  let data = store.enabled() ? await store.readJSON(path) : null;
  if (!data || !data.games) {
    try { data = await build(lg, season, fbs); if (store.enabled() && data.games) await store.writeJSON(path, data); }
    catch (e) { data = null; }
  }
  mem[k] = data;
  return data;
}

module.exports = { load, build };
