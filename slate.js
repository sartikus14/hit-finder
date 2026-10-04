// Hit Finder: serverless endpoint that ranks every starting hitter on a given date.
// GET /api/slate?date=YYYY-MM-DD  (defaults to today in US Eastern time)
// Data: MLB Stats API (statsapi.mlb.com). Personal, non-commercial use.

const API = 'https://statsapi.mlb.com/api/v1';
const LEAGUE_HIT_RATE = 0.218; // league hits per plate appearance
const SLOT_PA = [4.65, 4.55, 4.45, 4.35, 4.25, 4.15, 4.05, 3.95, 3.85];

// Team colors for the name-bar blocks (primary background, text color).
const TEAM_COLORS = {
  108: ['#BA0021', '#FFFFFF'], 109: ['#A71930', '#E3D4AD'], 110: ['#DF4601', '#000000'],
  111: ['#BD3039', '#FFFFFF'], 112: ['#0E3386', '#FFFFFF'], 113: ['#C6011F', '#FFFFFF'],
  114: ['#00385D', '#E50022'], 115: ['#33006F', '#C4CED4'], 116: ['#0C2340', '#FA4616'],
  117: ['#002D62', '#EB6E1F'], 118: ['#004687', '#BD9B60'], 119: ['#005A9C', '#FFFFFF'],
  120: ['#AB0003', '#FFFFFF'], 121: ['#002D72', '#FF5910'], 133: ['#003831', '#EFB21E'],
  134: ['#FDB827', '#27251F'], 135: ['#2F241D', '#FFC425'], 136: ['#0C2C56', '#00ADA9'],
  137: ['#FD5A1E', '#27251F'], 138: ['#C41E3A', '#FFFFFF'], 139: ['#092C5C', '#8FBCE6'],
  140: ['#003278', '#C0111F'], 141: ['#134A8E', '#FFFFFF'], 142: ['#002B5C', '#D31145'],
  143: ['#E81828', '#FFFFFF'], 144: ['#CE1141', '#FFFFFF'], 145: ['#27251F', '#C4CED4'],
  146: ['#00A3E0', '#000000'], 147: ['#0C2340', '#FFFFFF'], 158: ['#12284B', '#FFC52F']
};

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'HitFinder/1.0 (personal project)' } });
  if (!res.ok) throw new Error(`MLB Stats API returned ${res.status}`);
  return res.json();
}

const shrink = (hits, n, k) => (hits + LEAGUE_HIT_RATE * k) / (n + k);
const log5 = (b, p) => {
  const x = (b * p) / LEAGUE_HIT_RATE;
  const y = ((1 - b) * (1 - p)) / (1 - LEAGUE_HIT_RATE);
  return x / (x + y);
};
const f3 = (x) => (x >= 1 ? x.toFixed(3) : x.toFixed(3).slice(1));
const statsOf = (person, type) => (person.stats || []).find((s) => s.type && s.type.displayName === type);

function todayEastern() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date());
}

function teamInfo(team) {
  const c = TEAM_COLORS[team.id] || ['#2E4A38', '#FFFFFF'];
  return {
    id: team.id, name: team.name,
    nick: team.teamName || team.name.split(' ').slice(-1)[0],
    abbr: team.abbreviation || team.name.slice(0, 3).toUpperCase(),
    bg: c[0], fg: c[1]
  };
}

function pitcherFrom(person) {
  const splits = statsOf(person, 'statSplits');
  const season = statsOf(person, 'season');
  const side = (code) => {
    const s = ((splits && splits.splits) || []).find((x) => x.split && x.split.code === code);
    return { h: +(s && s.stat.hits) || 0, bf: +(s && s.stat.battersFaced) || 0 };
  };
  const st = (season && season.splits && season.splits[0] && season.splits[0].stat) || {};
  return {
    id: person.id, name: person.fullName,
    last: person.lastName || person.fullName.split(' ').slice(-1)[0],
    hand: (person.pitchHand && person.pitchHand.code) || 'R',
    vl: side('vl'), vr: side('vr'), era: st.era || '-', whip: st.whip || '-'
  };
}

function hitterFrom(person) {
  const splits = statsOf(person, 'statSplits');
  const side = (code) => {
    const s = ((splits && splits.splits) || []).find((x) => x.split && x.split.code === code);
    const t = (s && s.stat) || {};
    return {
      h: +t.hits || 0, pa: +t.plateAppearances || 0, k: +t.strikeOuts || 0,
      avg: t.avg || '.000', ops: t.ops || '.000'
    };
  };
  const total = statsOf(person, 'vsPlayerTotal');
  const bySeason = statsOf(person, 'vsPlayer');
  const h2hSrc = total && total.splits && total.splits.length ? total : bySeason;
  const h2h = ((h2hSrc && h2hSrc.splits) || []).reduce(
    (a, s) => ({ h: a.h + (+s.stat.hits || 0), ab: a.ab + (+s.stat.atBats || 0), pa: a.pa + (+s.stat.plateAppearances || 0) }),
    { h: 0, ab: 0, pa: 0 }
  );
  const lx = statsOf(person, 'lastXGames');
  const l = (lx && lx.splits && lx.splits[0] && lx.splits[0].stat) || {};
  return {
    id: person.id, name: person.fullName,
    bat: (person.batSide && person.batSide.code) || 'R',
    vl: side('vl'), vr: side('vr'), h2h,
    last: { h: +l.hits || 0, ab: +l.atBats || 0, pa: +l.plateAppearances || 0, avg: l.avg || '.000', hr: +l.homeRuns || 0 }
  };
}

// The model. Same reasoning as the scouting reports: platoon split, the pitcher's
// split vs the hitter's side (log5), recent form, head-to-head, lineup spot.
function score(h, P, slot) {
  const side = h.bat === 'S' ? (P.hand === 'R' ? 'L' : 'R') : h.bat;
  const hs = P.hand === 'L' ? h.vl : h.vr;
  const os = P.hand === 'L' ? h.vr : h.vl;
  const ps = side === 'L' ? P.vl : P.vr;
  const b = shrink(hs.h, hs.pa, 150);
  const pt = shrink(ps.h, ps.bf, 250);
  let p = log5(b, pt);
  const r = shrink(h.last.h, h.last.pa, 50);
  p = 0.85 * p + 0.15 * log5(r, pt);
  if (h.h2h.pa > 0) {
    const w = h.h2h.pa / (h.h2h.pa + 60);
    p = (1 - w) * p + w * (h.h2h.h / h.h2h.pa);
  }
  const expPa = slot ? SLOT_PA[slot - 1] : 4.2;
  const chance = 1 - Math.pow(1 - p, expPa);
  return { side, hs, os, pitcherRate: ps.bf ? ps.h / ps.bf : null, perPa: p, expPa, chance };
}

function factors(h, P, s, slot) {
  const hand = P.hand === 'L' ? 'LHP' : 'RHP';
  const sideWord = s.side === 'L' ? 'lefties' : 'righties';
  const out = [];
  const avg = parseFloat(s.hs.avg);
  const kPct = s.hs.pa ? Math.round((s.hs.k / s.hs.pa) * 100) : 0;
  if (s.hs.pa >= 40) {
    const v = avg >= 0.265 ? 1 : avg < 0.225 ? -1 : 0;
    out.push({ v, chip: `${s.hs.avg} vs ${hand}`,
      title: v > 0 ? `Hits ${hand} well` : v < 0 ? `Struggles vs ${hand}` : `Average vs ${hand}`,
      detail: `${s.hs.avg} AVG, ${s.hs.ops} OPS in ${s.hs.pa} PA vs ${hand} this season` });
  } else {
    out.push({ v: 0, chip: `Small sample vs ${hand}`, title: `Small sample vs ${hand}`,
      detail: `Only ${s.hs.pa} PA vs ${hand} this season, so this counts for less` });
  }
  if (s.pitcherRate !== null) {
    const pr = s.pitcherRate;
    const v = pr >= 0.225 ? 1 : pr < 0.2 ? -1 : 0;
    out.push({ v, chip: `${P.last}: ${f3(pr)} to ${s.side === 'L' ? 'LHB' : 'RHB'}`,
      title: v > 0 ? `${P.last} gives up hits to ${sideWord}` : v < 0 ? `${P.last} is tough on ${sideWord}` : `${P.last} is average vs ${sideWord}`,
      detail: `Allows ${f3(pr)} hits per batter faced to ${sideWord} (league about .218)` });
  }
  const { h: hh, ab, pa } = h.h2h;
  if (ab >= 3) {
    const r = hh / ab;
    const v = r >= 0.3 ? 1 : r < 0.15 && ab >= 5 ? -1 : 0;
    out.push({ v, chip: `${hh}-for-${ab} vs ${P.last}`,
      title: v > 0 ? `Has hit ${P.last} before` : v < 0 ? `Hasn't solved ${P.last}` : `Some history vs ${P.last}`,
      detail: `${hh}-for-${ab} career (${pa} PA)` });
  } else {
    out.push({ v: 0, chip: 'New matchup', title: 'Little or no history',
      detail: pa ? `${pa} career PA vs ${P.last}` : `Has never faced ${P.last}` });
  }
  if (h.last.pa >= 15) {
    const la = parseFloat(h.last.avg);
    const v = la >= 0.3 ? 1 : la < 0.2 ? -1 : 0;
    out.push({ v, chip: `${v > 0 ? 'Hot: ' : v < 0 ? 'Cold: ' : 'Last 15: '}${h.last.avg}`,
      title: v > 0 ? 'Hot bat' : v < 0 ? 'In a slump' : 'Steady lately',
      detail: `${h.last.h}-for-${h.last.ab} (${h.last.avg}) with ${h.last.hr} HR over his last 15 games` });
  }
  if (s.hs.pa >= 40 && (kPct <= 12 || kPct >= 30)) {
    const v = kPct <= 12 ? 1 : -1;
    out.push({ v, chip: `${v > 0 ? 'Rarely Ks: ' : 'Ks '}${kPct}%`,
      title: v > 0 ? 'Puts the ball in play' : 'Strikes out a lot',
      detail: `Strikes out in ${kPct}% of PA vs ${hand}` });
  }
  if (slot && slot <= 2) out.push({ v: 1, chip: 'Top of order', title: 'More trips to the plate', detail: `Batting ${slot === 1 ? 'leadoff' : '2nd'}, about ${SLOT_PA[slot - 1].toFixed(1)} PA expected` });
  if (slot && slot >= 8) out.push({ v: -1, chip: `Bats ${slot}th`, title: 'Fewer trips to the plate', detail: `Batting ${slot}th, about ${SLOT_PA[slot - 1].toFixed(1)} PA expected` });
  return out;
}

async function projectedLineup(teamId, season) {
  const j = await getJSON(`${API}/teams/${teamId}/roster?rosterType=active&season=${season}&hydrate=person(stats(type=season,group=hitting,season=${season}))`);
  return (j.roster || [])
    .filter((r) => r.person && r.person.primaryPosition && r.person.primaryPosition.abbreviation !== 'P')
    .map((r) => {
      const st = r.person.stats && r.person.stats[0] && r.person.stats[0].splits && r.person.stats[0].splits[0];
      return { id: r.person.id, fullName: r.person.fullName, pos: r.person.primaryPosition.abbreviation, pa: +(st && st.stat.plateAppearances) || 0 };
    })
    .sort((a, b) => b.pa - a.pa)
    .slice(0, 9);
}

async function buildSlate(date) {
  const sched = await getJSON(`${API}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,lineups,team`);
  const games = (sched.dates && sched.dates[0] && sched.dates[0].games) || [];
  if (!games.length) return { date, games: [] };
  const season = date.slice(0, 4);

  // One call for every probable starter on the slate.
  const pitcherIds = [];
  games.forEach((g) => ['away', 'home'].forEach((k) => {
    const pp = g.teams[k].probablePitcher;
    if (pp && !pitcherIds.includes(pp.id)) pitcherIds.push(pp.id);
  }));
  const pitchers = new Map();
  if (pitcherIds.length) {
    const pj = await getJSON(`${API}/people?personIds=${pitcherIds.join(',')}&hydrate=stats(group=[pitching],type=[season,statSplits],sitCodes=[vl,vr],season=${season})`);
    (pj.people || []).forEach((p) => pitchers.set(p.id, pitcherFrom(p)));
  }

  // One call per lineup (all nine hitters at once), run in parallel.
  const jobs = [];
  games.forEach((g) => ['away', 'home'].forEach((bat) => {
    const pit = bat === 'away' ? 'home' : 'away';
    jobs.push((async () => {
      const team = teamInfo(g.teams[bat].team);
      const pp = g.teams[pit].probablePitcher;
      const P = pp && pitchers.get(pp.id);
      if (!P) return { team, pitcher: null, hitters: [], projected: false, note: `${g.teams[pit].team.name} haven't named a starter yet.` };
      let lineup = (g.lineups && g.lineups[bat === 'away' ? 'awayPlayers' : 'homePlayers']) || [];
      let projected = false;
      if (!lineup.length) {
        lineup = (await projectedLineup(team.id, season)).map((x) => ({ id: x.id, fullName: x.fullName, primaryPosition: { abbreviation: x.pos } }));
        projected = true;
      }
      if (!lineup.length) return { team, pitcher: P, hitters: [], projected, note: 'No lineup available yet.' };
      const hj = await getJSON(`${API}/people?personIds=${lineup.map((x) => x.id).join(',')}&hydrate=stats(group=[hitting],type=[statSplits,vsPlayer,lastXGames],sitCodes=[vl,vr],opposingPlayerId=${P.id},limit=15,season=${season})`);
      const byId = new Map((hj.people || []).map((p) => [p.id, p]));
      const hitters = lineup.map((x, i) => {
        const person = byId.get(x.id);
        if (!person) return null;
        const h = hitterFrom(person);
        const slot = projected ? null : i + 1;
        const s = score(h, P, slot);
        return {
          id: h.id, name: x.fullName || h.name,
          pos: (x.primaryPosition && x.primaryPosition.abbreviation) || '',
          bat: h.bat, slot,
          chance: Math.round(s.chance * 100), perPa: +s.perPa.toFixed(3), expPa: +s.expPa.toFixed(1),
          vsHand: { avg: s.hs.avg, ops: s.hs.ops, pa: s.hs.pa, k: s.hs.pa ? Math.round((s.hs.k / s.hs.pa) * 100) : 0 },
          vsOther: { avg: s.os.avg, ops: s.os.ops, pa: s.os.pa, k: s.os.pa ? Math.round((s.os.k / s.os.pa) * 100) : 0 },
          h2h: h.h2h, last: h.last,
          factors: factors(h, P, s, slot)
        };
      }).filter(Boolean).sort((a, b) => b.chance - a.chance || b.perPa - a.perPa);
      return {
        team,
        pitcher: { name: P.name, last: P.last, hand: P.hand, era: P.era, whip: P.whip,
          vsL: P.vl.bf ? +(P.vl.h / P.vl.bf).toFixed(3) : null, vsR: P.vr.bf ? +(P.vr.h / P.vr.bf).toFixed(3) : null },
        projected, hitters
      };
    })().then((side) => ({ gamePk: g.gamePk, bat, side })));
  }));
  const sides = await Promise.all(jobs);

  return {
    date,
    updated: new Date().toISOString(),
    games: games.map((g) => {
      const st = (g.status && g.status.detailedState) || '';
      const abstract = (g.status && g.status.abstractGameState) || '';
      const mine = sides.filter((x) => x.gamePk === g.gamePk);
      return {
        id: g.gamePk, start: g.gameDate, desc: g.description || g.seriesDescription || '',
        status: st, live: abstract === 'Live', final: abstract === 'Final',
        away: { ...teamInfo(g.teams.away.team), sp: (g.teams.away.probablePitcher && g.teams.away.probablePitcher.fullName) || 'TBD' },
        home: { ...teamInfo(g.teams.home.team), sp: (g.teams.home.probablePitcher && g.teams.home.probablePitcher.fullName) || 'TBD' },
        sides: ['away', 'home'].map((k) => mine.find((x) => x.bat === k).side)
      };
    })
  };
}

module.exports = async function handler(req, res) {
  const q = (req.query && req.query.date) || '';
  const date = /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : todayEastern();
  try {
    const data = await buildSlate(date);
    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    res.status(200).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Could not load MLB data right now. Try again in a minute.', detail: String(err && err.message || err) });
  }
};

module.exports.buildSlate = buildSlate;
module.exports.score = score;
