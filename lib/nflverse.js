// nflverse (free NFL data on GitHub): team EPA per play, player target/air-yards share, snap counts.
// Built once a day by the daily job and stored; rebuilt on demand if missing.
const zlib = require('zlib');
const store = require('./store');

const REL = 'https://github.com/nflverse/nflverse-data/releases/download/';
const TO_ESPN = { LA: 'LAR', WAS: 'WSH', OAK: 'LV', SD: 'LAC', STL: 'LAR' };
const espnAb = (t) => TO_ESPN[t] || t;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+(jr\.?|sr\.?|ii|iii|iv|v)$/i, '').replace(/[^a-z]/g, '');

function csv(t) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const h = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(h.map((k, i) => [k, r[i]])));
}

async function getCsv(path) {
  const r = await fetch(REL + path, { headers: { 'User-Agent': 'HitFinder/1.0 (personal project)' } });
  if (!r.ok) throw new Error('nflverse ' + path + ' ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  return csv((path.endsWith('.gz') ? zlib.gunzipSync(buf) : buf).toString('utf8'));
}

async function build(season) {
  const [team, players, snaps] = await Promise.all([
    getCsv(`stats_team/stats_team_week_${season}.csv.gz`),
    getCsv(`stats_player/stats_player_week_${season}.csv.gz`),
    getCsv(`snap_counts/snap_counts_${season}.csv.gz`).catch(() => [])
  ]);
  const n = (x) => +x || 0;
  // team offense EPA per play by week (defense = what the opponent's offense did)
  const teams = {};
  team.forEach((r) => {
    const plays = n(r.attempts) + n(r.sacks_suffered) + n(r.carries);
    if (!plays) return;
    (teams[espnAb(r.team)] = teams[espnAb(r.team)] || []).push({ week: n(r.week), type: r.season_type, opp: espnAb(r.opponent_team), plays, epa: n(r.passing_epa) + n(r.rushing_epa) });
  });
  Object.values(teams).forEach((list) => list.forEach((g) => {
    const o = (teams[g.opp] || []).find((x) => x.week === g.week && x.type === g.type);
    g.oe = +(g.epa / g.plays).toFixed(4);
    g.de = o ? +(o.epa / o.plays).toFixed(4) : null;
  }));
  // players: per-week target share, air yards share, aDOT; snap %
  const P = {};
  const key = (name, t) => norm(name) + '|' + espnAb(t);
  players.forEach((r) => {
    if (!(n(r.targets) || n(r.carries) || n(r.attempts))) return;
    const k = key(r.player_display_name, r.team);
    (P[k] = P[k] || { w: [] }).w.push({ wk: n(r.week), tsh: +(n(r.target_share)).toFixed(3), ash: +(n(r.air_yards_share)).toFixed(3), tgt: n(r.targets), air: n(r.receiving_air_yards) });
  });
  snaps.forEach((r) => {
    const k = key(r.player, r.team);
    (P[k] = P[k] || { w: [] });
    (P[k].s = P[k].s || []).push({ wk: n(r.week), pct: +(n(r.offense_pct)).toFixed(3) });
  });
  return { season, built: new Date().toISOString(), teams, players: P };
}

const mem = {};
async function load(season, { refresh = false } = {}) {
  const k = String(season);
  if (!refresh && mem[k] && Date.now() - mem[k].at < 60 * 60e3) return mem[k].data;
  let data = null;
  const path = `fb/nflverse-${season}.json`;
  if (!refresh && store.enabled()) data = await store.readJSON(path);
  const stale = !data || Date.now() - Date.parse(data.built || 0) > 30 * 3600e3;
  if (refresh || stale) {
    try { data = await build(season); if (store.enabled()) await store.writeJSON(path, data); }
    catch (e) { if (!data) data = null; }
  }
  mem[k] = { at: Date.now(), data };
  return data;
}

// Season and last-2-week summaries for one ESPN player
function playerInfo(nv, name, teamAb) {
  if (!nv) return null;
  const p = nv.players[norm(name) + '|' + teamAb];
  if (!p) return null;
  const w = (p.w || []).slice().sort((a, b) => a.wk - b.wk), s = (p.s || []).slice().sort((a, b) => a.wk - b.wk);
  const avg = (xs, f) => (xs.length ? xs.reduce((a, x) => a + f(x), 0) / xs.length : null);
  const tgt = w.reduce((a, x) => a + x.tgt, 0), air = w.reduce((a, x) => a + x.air, 0);
  return {
    tsh: avg(w, (x) => x.tsh), tsh2: avg(w.slice(-2), (x) => x.tsh), ash: avg(w, (x) => x.ash),
    adot: tgt >= 8 ? air / tgt : null,
    snap: avg(s, (x) => x.pct), snap2: avg(s.slice(-2), (x) => x.pct), snapGames: s.length
  };
}

module.exports = { load, build, playerInfo, espnAb };
