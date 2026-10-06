// Keeps a season's worth of finished football games, stored once and reused.
const espn = require('./espn');
const store = require('./store');
const FB = require('./football');
const nflverse = require('./nflverse');
const prior = require('./prior');
const weather = require('./weather');

const mem = {}; // per-instance cache
const SCHEMA = 2; // bump when the stored game format changes

function seasonInfo(sb) {
  return {
    season: (sb.season && sb.season.year) || new Date().getFullYear(),
    type: (sb.season && sb.season.type) || 2,
    week: (sb.week && sb.week.number) || 1
  };
}

// Finished-game ids for the season so far, week by week.
async function finishedIds(lg, info, data, onlyTeams) {
  const weeks = [];
  const regMax = lg === 'nfl' ? 18 : 16;
  const lastReg = info.type === 1 ? 0 : info.type === 2 ? info.week : regMax;
  for (let w = 1; w <= lastReg; w++) weeks.push({ week: w, seasontype: 2 });
  if (info.type === 3) for (let w = 1; w <= info.week; w++) weeks.push({ week: w, seasontype: 3 });
  data.weekDone = data.weekDone || {};
  const todo = weeks.filter((x) => !data.weekDone[x.seasontype + '-' + x.week]);
  const ids = [];
  await espn.pool(todo, 6, async (x) => {
    const sb = await espn.scoreboard(lg, { week: x.week, seasontype: x.seasontype, year: info.season });
    const evs = sb.events || [];
    let allDone = evs.length > 0;
    evs.forEach((e) => {
      const done = e.status && e.status.type && e.status.type.completed;
      if (!done) { allDone = false; return; }
      if (onlyTeams && !e.competitions[0].competitors.some((c) => onlyTeams.has(String(c.team.id)))) return;
      ids.push(String(e.id));
    });
    if (allDone && !onlyTeams && (info.type === 3 || x.week < info.week)) data.weekDone[x.seasontype + '-' + x.week] = true;
  });
  return ids;
}

async function updateGames(lg, info, data, { limit = 400, onlyTeams = null } = {}) {
  if (lg === 'cfb' && !data.fbs) { try { data.fbs = await espn.fbsTeamIds(info.season); } catch (e) { data.fbs = null; } }
  const ids = (await finishedIds(lg, info, data, onlyTeams)).filter((id) => !data.games[id]);
  const batch = ids.slice(0, limit);
  const got = await espn.pool(batch, 8, async (id) => espn.compactGame(await espn.gameSummary(lg, id), lg));
  got.forEach((g) => { if (g && g.completed) data.games[g.id] = g; });
  data.updated = new Date().toISOString();
  return { added: got.filter(Boolean).length, remaining: ids.length - batch.length };
}

const path = (lg, season) => `fb/${lg}-${season}.json`;

// Returns { data, info } with every finished game this season (or the slate teams' games without storage).
async function loadGames(lg, sb, { refresh = false } = {}) {
  const info = seasonInfo(sb);
  const k = lg + info.season;
  const fresh = (d) => d && d.updated && Date.now() - Date.parse(d.updated) < 6 * 3600e3;
  if (!refresh && mem[k] && Date.now() - mem[k].at < 15 * 60e3) return { data: mem[k].data, info };
  let data = null;
  if (store.enabled()) {
    data = await store.readJSON(path(lg, info.season));
    if (!data || data.season !== info.season || data.v !== SCHEMA || refresh || !fresh(data)) {
      // a new season or a new record format starts the game list over
      data = data && data.season === info.season && data.v === SCHEMA ? data : { lg, season: info.season, v: SCHEMA, games: {}, fbs: null };
      const r = await updateGames(lg, info, data, { limit: refresh ? 400 : 160 });
      data.remaining = r.remaining;
      await store.writeJSON(path(lg, info.season), data);
    }
  } else {
    // No storage: build just what this slate needs.
    data = { lg, season: info.season, v: SCHEMA, games: {}, fbs: null };
    let only = null;
    if (lg === 'cfb') {
      only = new Set();
      (sb.events || []).forEach((e) => {
        const cs = e.competitions[0].competitors;
        if (cs.some((c) => c.curatedRank && c.curatedRank.current <= 25)) cs.forEach((c) => only.add(String(c.team.id)));
      });
    }
    await updateGames(lg, info, data, { limit: 300, onlyTeams: only });
  }
  mem[k] = { at: Date.now(), data };
  return { data, info };
}

const rosterMem = {};
async function rostersFor(lg, teamIds) {
  const k = lg + ':' + teamIds.slice().sort().join(',');
  if (rosterMem[k] && Date.now() - rosterMem[k].at < 30 * 60e3) return rosterMem[k].data;
  const data = await espn.rosters(lg, teamIds);
  rosterMem[k] = { at: Date.now(), data };
  return data;
}

// Full slate with picks, ready for the site.
async function slate(lg, { calib = null, refresh = false } = {}) {
  const sb = await espn.currentSlate(lg);
  const { data, info } = await loadGames(lg, sb, { refresh });
  const fbs = data.fbs ? new Set(data.fbs) : null;
  // extras: nflverse (NFL), last season's ratings, kickoff weather. Each one is optional.
  const [nv, pri, wx] = await Promise.all([
    lg === 'nfl' ? nflverse.load(info.season).catch(() => null) : null,
    prior.load(lg, info.season - 1, fbs).catch(() => null),
    // college: only the games the site shows (a ranked team playing)
    weather.forKickoffs((sb.events || []).filter((e) => lg !== 'cfb' || e.competitions[0].competitors.some((c) => c.curatedRank && c.curatedRank.current <= 25))).catch(() => ({}))
  ]);
  const tables = FB.buildTables(lg, Object.values(data.games), fbs, { nv });
  const rt = FB.ratings(lg, tables, pri);
  const ids = new Set();
  (sb.events || []).forEach((e) => {
    const cs = e.competitions[0].competitors;
    if (lg === 'cfb' && !cs.some((c) => c.curatedRank && c.curatedRank.current <= 25)) return;
    cs.forEach((c) => ids.add(String(c.team.id)));
  });
  let rost = null;
  try { rost = await rostersFor(lg, [...ids]); } catch (e) { rost = null; }
  if (calib === null && store.enabled()) { const c = await store.readJSON('calib.json'); calib = (c && c[lg]) || {}; }
  const out = FB.buildSlate(lg, sb, tables, rt, rost, calib || {}, { weather: wx, nvInfo: nv ? (name, ab) => nflverse.playerInfo(nv, name, ab) : null });
  return {
    lg, season: info.season, seasonType: info.type, week: info.week,
    label: (sb.week && sb.week.text) || ('Week ' + info.week),
    updated: new Date().toISOString(), gamesInModel: tables.done.length, stillLoading: data.remaining || 0,
    tracking: store.enabled(), learned: calib || {},
    sources: { nflverse: !!nv, epa: !!rt.useEpa, lastSeason: !!pri, weather: Object.keys(wx || {}).length },
    ...out
  };
}

module.exports = { slate, loadGames, updateGames, seasonInfo };
