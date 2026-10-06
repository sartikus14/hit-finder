// Football model: opponent-adjusted team ratings, spread / total / winner picks,
// anytime-TD chances and yardage projections, plus the reasons behind each.

const CFG = {
  nfl: { hfa: 1.7, cap: 17, strong: 2.5, solid: 1.2, qbOut: 3, tdPerPt: 1 / 9.8, ypt: 8.0 },
  cfb: { hfa: 2.7, cap: 24, strong: 3.0, solid: 1.5, qbOut: 0, tdPerPt: 1 / 9.5, ypt: 8.5 }
};
const OUT = /out|injured reserve|doubtful|suspen|pup/i;
// NFL home time zones (hours from Eastern), for travel and early body-clock games
const TZ = { ATL: 0, BAL: 0, BUF: 0, CAR: 0, CIN: 0, CLE: 0, DET: 0, IND: 0, JAX: 0, MIA: 0, NE: 0, NYG: 0, NYJ: 0, PHI: 0, PIT: 0, TB: 0, WSH: 0,
  CHI: -1, DAL: -1, GB: -1, HOU: -1, KC: -1, MIN: -1, NO: -1, TEN: -1, DEN: -2, ARI: -3, LAR: -3, LAC: -3, LV: -3, SF: -3, SEA: -3 };
const etHour = (iso) => +new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date(iso)) % 24;

const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const softCap = (m, X) => { const a = Math.abs(m); return Math.sign(m) * (a <= X ? a : X + 0.3 * (a - X)); };
const fmtLine = (n) => (n === 0 ? 'PK' : n > 0 ? '+' + n : '' + n);
const f = (v, title, detail) => ({ v, title, detail });

// ---------- season tables from finished games ----------
function buildTables(lg, gamesList, fbs, ext = {}) {
  const isFbs = (id) => lg !== 'cfb' || !fbs || fbs.has(id);
  const key = (id) => (isFbs(id) ? id : 'FCS');
  const T = {};
  const mk = (id) => T[id] || (T[id] = { id, g: 0, pf: 0, pa: 0, plays: 0, yds: 0, oplays: 0, oyds: 0, to: 0, tk: 0, rzA: 0, rzTD: 0, rzKnown: false, t3c: 0, t3a: 0,
    passAtt: 0, rushAtt: 0, oRushYds: 0, oRushAtt: 0, oPassYds: 0, oPassAtt: 0, oRushTD: 0, oRecTD: 0, games: [] });
  const players = {};
  const done = gamesList.filter((g) => g && g.completed).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  for (const g of done) {
    const sides = [[g.home, g.away, true], [g.away, g.home, false]];
    for (const [me, op, isHome] of sides) {
      const k = key(me.id);
      const t = mk(k);
      if (k !== 'FCS') t.ab = me.ab;
      const ms = g.teams[me.id] || {}, os = g.teams[op.id] || {};
      t.g++; t.pf += me.score; t.pa += op.score;
      t.plays += ms.plays || 0; t.yds += ms.yds || 0; t.oplays += os.plays || 0; t.oyds += os.yds || 0;
      t.to += ms.to || 0; t.tk += os.to || 0; t.t3c += ms.t3c || 0; t.t3a += ms.t3a || 0;
      if (ms.rzA != null) { t.rzA += ms.rzA; t.rzTD += ms.rzTD; t.rzKnown = true; }
      t.passAtt += ms.passAtt || 0; t.rushAtt += ms.rushAtt || 0;
      t.oRushYds += os.rushYds || 0; t.oRushAtt += os.rushAtt || 0; t.oPassYds += os.passYds || 0; t.oPassAtt += os.passAtt || 0;
      t.games.push({ id: g.id, date: g.date, opp: key(op.id), oppAb: op.ab, pf: me.score, pa: op.score, home: isHome, neutral: g.neutral,
        ypp: ms.plays ? ms.yds / ms.plays : null, oypp: os.plays ? os.yds / os.plays : null });
    }
    for (const p of g.players) {
      const opp = p.t === g.home.id ? g.away : g.home;
      const ot = T[key(opp.id)];
      if (ot) { ot.oRushTD += p.rtd || 0; ot.oRecTD += p.retd || 0; }
      const rec = players[p.id] || (players[p.id] = { id: p.id, n: p.n, pos: p.pos, t: p.t, logs: [] });
      rec.n = p.n; rec.t = p.t; if (p.pos) rec.pos = p.pos;
      rec.logs.push({ ...p, gid: g.id, date: g.date, opp: opp.id, oppAb: opp.ab, tgtKnown: g.tgtKnown });
    }
  }
  // NFL: attach nflverse EPA per play to each game (matched by opponent, in week order)
  if (ext.nv && ext.nv.teams) {
    for (const t of Object.values(T)) {
      const list = (ext.nv.teams[t.ab] || []).slice().sort((a, b) => a.week - b.week);
      const used = new Set();
      t.games.forEach((g) => {
        const i = list.findIndex((x, j) => !used.has(j) && x.opp === g.oppAb);
        if (i >= 0 && list[i].de != null) { used.add(i); g.oe = list[i].oe; g.de = list[i].de; g.ep = list[i].plays; }
      });
    }
  }
  const real = Object.values(T).filter((t) => t.id !== 'FCS' && t.g);
  const tot = (fn) => sum(real, fn);
  const G = tot((t) => t.g) || 1;
  const LG = {
    pts: tot((t) => t.pf) / G, plays: tot((t) => t.plays) / G,
    ypp: tot((t) => t.yds) / Math.max(1, tot((t) => t.plays)),
    ypc: tot((t) => t.oRushYds) / Math.max(1, tot((t) => t.oRushAtt)),
    ypa: tot((t) => t.oPassYds) / Math.max(1, tot((t) => t.oPassAtt)),
    rtd: tot((t) => t.oRushTD) / G, ctd: tot((t) => t.oRecTD) / G,
    ryg: tot((t) => t.oRushYds) / G, pyg: tot((t) => t.oPassYds) / G
  };
  const eg = [].concat(...real.map((t) => t.games.filter((g) => g.oe != null)));
  LG.epa = eg.length ? sum(eg, (g) => g.oe * g.ep) / sum(eg, (g) => g.ep) : null;
  LG.epaCoverage = real.length ? eg.length / sum(real, (t) => t.games.length) : 0;
  return { T, players, LG, key, done };
}

// Opponent-adjusted ratings (iterative ridge): margin, yards per play, points.
function ratings(lg, tables, prior) {
  const { T, LG } = tables;
  const C = CFG[lg];
  const ids = Object.keys(T);
  const r = {}, off = {}, def = {}, po = {}, pd = {};
  ids.forEach((id) => { r[id] = 0; off[id] = 0; def[id] = 0; po[id] = 0; pd[id] = 0; });
  const lam = 2;
  // NFL uses EPA per play (from nflverse) when it covers the season; otherwise yards per play
  const useEpa = lg === 'nfl' && LG.epa != null && LG.epaCoverage >= 0.8;
  const K = useEpa ? 65 : 6.5, base = useEpa ? LG.epa : LG.ypp;
  const val = (g) => (useEpa ? g.oe : g.ypp), oval = (g) => (useEpa ? g.de : g.oypp);
  for (let it = 0; it < 60; it++) {
    for (const id of ids) {
      const t = T[id]; let s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, n = 0, ny = 0;
      for (const g of t.games) {
        const h = g.neutral ? 0 : (g.home ? C.hfa : -C.hfa);
        s1 += softCap(g.pf - g.pa, C.cap) - h + (r[g.opp] || 0);
        s4 += g.pf - LG.pts - (pd[g.opp] || 0);
        s5 += g.pa - LG.pts - (po[g.opp] || 0);
        if (val(g) != null && oval(g) != null) { s2 += val(g) - base - (def[g.opp] || 0); s3 += oval(g) - base - (off[g.opp] || 0); ny++; }
        n++;
      }
      r[id] = s1 / (n + lam); po[id] = s4 / (n + lam); pd[id] = s5 / (n + lam);
      off[id] = ny ? s2 / (ny + lam) : 0; def[id] = ny ? s3 / (ny + lam) : 0;
    }
  }
  const power = {}, sos = {}, priorShare = {};
  // Last season's rating as a starting point. Fades to nothing after 8 games (NFL) or 6 (college).
  const N = lg === 'nfl' ? 8 : 6, carry = lg === 'nfl' ? 0.7 : 0.45;
  for (const id of ids) {
    const t = T[id];
    const toM = t.g ? (t.tk - t.to) / t.g : 0;
    power[id] = 0.55 * r[id] + 0.45 * K * (off[id] - def[id]) - 0.25 * 4 * toM;
    sos[id] = t.g ? sum(t.games, (g) => r[g.opp] || 0) / t.g : 0;
    const sh = prior && prior.r && prior.r[id] != null ? Math.max(0, 1 - t.g / N) : 0;
    priorShare[id] = sh;
    if (sh > 0) {
      power[id] = (1 - sh) * power[id] + sh * carry * prior.r[id];
      po[id] = (1 - sh) * po[id] + sh * carry * (prior.po[id] || 0);
      pd[id] = (1 - sh) * pd[id] + sh * carry * (prior.pd[id] || 0);
    }
  }
  return { r, off, def, po, pd, power, sos, priorShare, useEpa, prior: prior ? prior.r : null };
}

function epaAvg(games, k) {
  const gs = games.filter((g) => g[k] != null && g.ep);
  return gs.length ? Math.round(1000 * sum(gs, (g) => g[k] * g.ep) / sum(gs, (g) => g.ep)) / 1000 : null;
}

function teamStats(t) {
  if (!t || !t.g) return null;
  return {
    g: t.g, ppg: r1(t.pf / t.g), pa: r1(t.pa / t.g), diff: r1((t.pf - t.pa) / t.g),
    yppO: t.plays ? r1(t.yds / t.plays) : null, yppD: t.oplays ? r1(t.oyds / t.oplays) : null,
    toM: t.tk - t.to, t3: t.t3a ? Math.round((100 * t.t3c) / t.t3a) : null,
    rz: t.rzKnown && t.rzA ? Math.round((100 * t.rzTD) / t.rzA) : null,
    epaO: epaAvg(t.games, 'oe'), epaD: epaAvg(t.games, 'de')
  };
}

// ---------- the slate ----------
function lineFromEvent(c) {
  const o = (c.odds || [])[0] || {};
  let sp = typeof o.spread === 'number' ? o.spread : null;
  const details = o.details || '';
  if (sp == null && details) {
    const m = details.match(/^([A-Z&\.\-]+)\s+([+-]?\d+(?:\.\d+)?)$/);
    if (m) {
      const home = c.competitors.find((x) => x.homeAway === 'home');
      sp = m[1] === home.team.abbreviation ? +m[2] : -m[2];
    } else if (/even|pk/i.test(details)) sp = 0;
  }
  const num = (x) => { const v = parseFloat(String(x || '').replace(/^[ou]/i, '')); return isNaN(v) ? null : v; };
  const spOpen = o.pointSpread && o.pointSpread.home && o.pointSpread.home.open ? num(o.pointSpread.home.open.line) : null;
  const ouOpen = o.total && o.total.over && o.total.over.open ? num(o.total.over.open.line) : null;
  return { sp, ou: typeof o.overUnder === 'number' ? o.overUnder : null, details, book: (o.provider && o.provider.name) || '', spOpen, ouOpen };
}

function buildSlate(lg, sb, tables, rt, rost, calib, ext = {}) {
  const C = CFG[lg];
  const { T, LG, players, key } = tables;
  const cal = calib || {};
  const tdMult = cal.tdMult || 1, yMult = cal.ydsMult || {};
  const gpt = Object.values(T).filter((t) => t.id !== 'FCS').reduce((a, t, _, arr) => a + t.g / arr.length, 0);
  const w = clamp((0.2 + 0.05 * gpt) * (cal.trust || 1), 0.15, 0.75);
  // Core numbers for every game on the board (all of them, so the scale fit has enough games).
  const qbOut = (tid) => {
    if (!rost) return null;
    const qbs = Object.values(players).filter((p) => p.t === tid && p.logs.some((l) => l.att >= 10))
      .map((p) => ({ p, att: sum(p.logs.slice(-3), (l) => l.att) })).sort((a, b) => b.att - a.att);
    const top = qbs[0];
    const inj = top && rost[top.p.id] && rost[top.p.id].inj;
    return top && inj && OUT.test(inj) ? top.p.n : null;
  };
  const lastGame = (k) => { const t = T[k]; return t && t.games.length ? t.games[t.games.length - 1].date : null; };
  const restOf = (k, kick) => { const d = lastGame(k); return d ? (Date.parse(kick) - Date.parse(d)) / 86400e3 : null; };
  const restPts = (days) => (days == null ? 0 : days <= 5.5 ? -1 : days >= 12.5 ? 1 : 0) * (lg === 'nfl' ? 1 : 0.7);
  // key defenders (about 3.5+ tackles a game lately) on the injury report as out
  const defOut = (tid) => {
    if (!rost) return [];
    const myT = T[key(tid)];
    const recent = myT ? new Set(myT.games.slice(-3).map((g) => g.id)) : new Set();
    return Object.values(players).filter((p) => p.t === tid && rost[p.id] && OUT.test(rost[p.id].inj || ''))
      .filter((p) => { const ls = p.logs.filter((l) => recent.has(l.gid) && l.tk != null); return ls.length >= 2 && sum(ls, (l) => l.tk) / ls.length >= 3.5; })
      .map((p) => p.n).slice(0, 3);
  };
  const core = (e) => {
    const c = e.competitions[0];
    const hc = c.competitors.find((x) => x.homeAway === 'home'), ac = c.competitors.find((x) => x.homeAway === 'away');
    const H = String(hc.team.id), A = String(ac.team.id);
    const kH = key(H), kA = key(A);
    const tH = T[kH], tA = T[kA];
    const neutral = !!c.neutralSite;
    const hfa = neutral ? 0 : C.hfa;
    const line = lineFromEvent(c);
    const indoor = !!(c.venue && c.venue.indoor);
    const wx = e.weather ? { text: e.weather.displayValue || '', temp: e.weather.temperature || null } : null;
    const fc = !indoor && ext.weather ? ext.weather[String(e.id)] : null;
    const wet = !indoor && (fc ? fc.rain >= 60 : wx && /rain|snow|storm|shower/i.test(wx.text));
    const windy = fc ? Math.max(0, Math.max(fc.wind, 0.7 * fc.gust) - 12) : 0;
    // things measured in points that go on top of the ratings
    const restH = restOf(kH, e.date), restA = restOf(kA, e.date);
    let travel = 0, travelNote = null;
    if (lg === 'nfl' && !neutral && TZ[hc.team.abbreviation] != null && TZ[ac.team.abbreviation] != null) {
      const dz = TZ[hc.team.abbreviation] - TZ[ac.team.abbreviation];
      if (Math.abs(dz) >= 2) { travel += 0.4; travelNote = ac.team.abbreviation + ' crossing ' + Math.abs(dz) + ' time zones'; }
      if (TZ[ac.team.abbreviation] <= -2 && TZ[hc.team.abbreviation] === 0 && etHour(e.date) <= 13) { travel += 1; travelNote = 'West Coast team at an early East Coast kickoff'; }
    }
    const dH = lg === 'nfl' ? defOut(H) : [], dA = lg === 'nfl' ? defOut(A) : [];
    const adjM = restPts(restH) - restPts(restA) + travel + 0.6 * (dA.length - dH.length);
    const adjT = -Math.min(4.5, 0.3 * windy) - (wet ? 1 : 0) + 0.5 * (dA.length + dH.length);
    const qH = C.qbOut ? qbOut(H) : null, qA = C.qbOut ? qbOut(A) : null;
    const pw = (k) => rt.power[k] || 0;
    const rawM = pw(kH) - pw(kA) + hfa + (qA ? C.qbOut : 0) - (qH ? C.qbOut : 0);
    const ptsFor = (o, d) => LG.pts + (rt.po[o] || 0) + (rt.pd[d] || 0);
    const pace = tH && tA && tH.g && tA.g ? ((tH.plays / tH.g + tA.plays / tA.g) / 2) / LG.plays : 1;
    const rawT = (ptsFor(kH, kA) + ptsFor(kA, kH)) * (0.85 + 0.15 * pace);
    return { c, hc, ac, H, A, kH, kA, tH, tA, neutral, hfa, line, indoor, wx, fc, wet, windy, qH, qA, rawM, rawT, adjM, adjT, restH, restA, travel, travelNote, dH, dA };
  };
  const all = (sb.events || []).map(core);
  // Put the app's ratings on the same scale as the betting market (fit across the whole board),
  // so it disagrees with Vegas about which team is better, not about how spread out lines are.
  const withSp = all.filter((x) => x.line.sp != null && Math.abs(x.rawM) > 0.1);
  let mScale = 1;
  if (withSp.length >= 8) mScale = clamp(sum(withSp, (x) => x.rawM * -x.line.sp) / sum(withSp, (x) => x.rawM * x.rawM), 0.5, 2.5);
  const withOu = all.filter((x) => x.line.ou != null);
  let tA0 = 0, tB = 1;
  if (withOu.length >= 8) {
    const mx = sum(withOu, (x) => x.rawT) / withOu.length, my = sum(withOu, (x) => x.line.ou) / withOu.length;
    const vx = sum(withOu, (x) => (x.rawT - mx) ** 2);
    tB = vx > 0 ? clamp(sum(withOu, (x) => (x.rawT - mx) * (x.line.ou - my)) / vx, 0.4, 1.2) : 1;
    tA0 = my - tB * mx;
  }
  const shown = all.filter((x) => lg !== 'cfb' || x.c.competitors.some((cc) => cc.curatedRank && cc.curatedRank.current <= 25));

  const games = [];
  for (const X of shown) {
    const { c, hc, ac, H, A, kH, kA, tH, tA, neutral, line, indoor, wx, wet, qH, qA, fc, windy } = X;
    const e = (sb.events || []).find((ev) => ev.competitions[0] === c);
    const status = (e.status && e.status.type) || {};
    const rawM = X.rawM * mScale + X.adjM, rawT = tA0 + tB * X.rawT + X.adjT;
    const m = line.sp != null ? w * rawM + (1 - w) * -line.sp : rawM;
    const tt = line.ou != null ? w * rawT + (1 - w) * line.ou : rawT;
    const conf = (x) => (Math.abs(x) >= C.strong ? 'Strong' : Math.abs(x) >= C.solid ? 'Solid' : 'Lean');
    const ab = { [H]: hc.team.abbreviation, [A]: ac.team.abbreviation };
    let spread = null, total = null;
    if (line.sp != null) {
      const edge = m + line.sp, homeSide = edge > 0;
      const team = homeSide ? H : A, ln = homeSide ? line.sp : -line.sp;
      spread = { team: ab[team], teamId: team, line: ln, label: ab[team] + ' ' + fmtLine(ln), edge: r1(Math.abs(edge)), conf: conf(edge) };
      if (line.spOpen != null && line.spOpen !== line.sp) {
        const move = line.sp - line.spOpen; // + means the home team got less favored
        const against = homeSide ? move > 0 : move < 0;
        spread.moved = { from: line.spOpen, by: r1(Math.abs(move)), against, toward: move < 0 ? ab[H] : ab[A] };
        // a big move against the pick usually means the market knows something: drop one confidence level
        if (against && Math.abs(move) >= 2.5 && spread.conf !== 'Lean') { spread.confBefore = spread.conf; spread.conf = spread.conf === 'Strong' ? 'Solid' : 'Lean'; }
      }
    }
    if (line.ou != null) {
      const te = tt - line.ou;
      total = { side: te > 0 ? 'Over' : 'Under', line: line.ou, label: (te > 0 ? 'Over ' : 'Under ') + line.ou, edge: r1(Math.abs(te)), conf: conf(te) };
    }
    const hPts = tt / 2 + m / 2, aPts = tt / 2 - m / 2;
    const implied = {
      [H]: line.ou != null && line.sp != null ? line.ou / 2 - line.sp / 2 : hPts,
      [A]: line.ou != null && line.sp != null ? line.ou / 2 + line.sp / 2 : aPts
    };
    const team = (cc, k, qb) => ({
      id: String(cc.team.id), ab: cc.team.abbreviation, name: cc.team.name || cc.team.shortDisplayName, loc: cc.team.location,
      color: cc.team.color || '5A5A5A', alt: cc.team.alternateColor || 'FFFFFF',
      rank: cc.curatedRank && cc.curatedRank.current <= 25 ? cc.curatedRank.current : null,
      rec: (cc.records && cc.records[0] && cc.records[0].summary) || '', score: cc.score != null ? +cc.score : null,
      stats: teamStats(T[k]), rating: r1(rt.power[k] || 0), sos: r1(rt.sos[k] || 0), qbOut: qb
    });
    const G = {
      id: String(e.id), date: e.date, state: status.state || 'pre', detail: status.shortDetail || '', completed: !!status.completed,
      venue: (c.venue && c.venue.fullName) || '', indoor, neutral, wx, forecast: fc || null,
      rest: { home: X.restH != null ? Math.round(X.restH) : null, away: X.restA != null ? Math.round(X.restA) : null },
      away: team(ac, kA, qA), home: team(hc, kH, qH), line,
      proj: { margin: r1(m), total: r1(tt), home: Math.round(hPts), away: Math.round(aPts), winner: m >= 0 ? ab[H] : ab[A],
        winPct: Math.round(100 / (1 + Math.exp(-Math.abs(m) / (lg === 'cfb' ? 7 : 6.5)))), rawMargin: r1(rawM), rawTotal: r1(rawT), weight: r1(w) },
      spread, total, implied: { [ab[H]]: r1(implied[H]), [ab[A]]: r1(implied[A]) }
    };
    G.factors = gameFactors(lg, G, tH, tA, rt, kH, kA, wet, X);

    // players
    const P = {};
    const weatherPass = 1 - Math.min(0.15, 0.012 * (windy || 0)) - (fc && fc.rain >= 60 ? 0.03 : 0);
    for (const [tid, oid] of [[H, A], [A, H]]) {
      const O = T[key(oid)] || { g: 1, oRushTD: 0, oRecTD: 0, oRushYds: 0, oRushAtt: 1, oPassYds: 0, oPassAtt: 1, oplays: 0 };
      const myT = T[key(tid)];
      const recentIds = myT ? new Set(myT.games.slice(-3).map((g) => g.id)) : null;
      const isOut = (p) => !!(rost && rost[p.id] && OUT.test(rost[p.id].inj || ''));
      const active = Object.values(players).filter((p) => p.t === tid && (!recentIds || p.logs.some((l) => recentIds.has(l.gid))))
        .map((p) => ({ p, a: aggPlayer(p) })).filter((x) => x.a.car + x.a.tgt > 0);
      const posOf = (x) => (rost && rost[x.p.id] && rost[x.p.id].pos) || x.p.pos || (x.a.att > x.a.car ? 'QB' : x.a.car > x.a.tgt ? 'RB' : 'WR');
      // an injured QB's runs go to the backup QB, not the running backs
      const outs = active.filter((x) => isOut(x.p) && x.a.wg && posOf(x) !== 'QB');
      const skill = active.filter((x) => !isOut(x.p));
      if (!skill.length) continue;
      // touches left behind by injured players get passed to teammates in proportion to their roles
      const missCar = sum(outs, (x) => x.a.wcar / x.a.wg) * 0.9, missTgt = sum(outs, (x) => x.a.wtgt / x.a.wg) * 0.9;
      const outNames = outs.filter((x) => x.a.wcar / x.a.wg >= 3 || x.a.wtgt / x.a.wg >= 2.5).map((x) => x.p.n);
      const s = (fn) => sum(skill, fn) || 1;
      const isBack = (x) => ['RB', 'FB', 'HB'].includes(posOf(x)) || (!posOf(x) && x.a.car > x.a.tgt);
      const carPool = s((x) => (isBack(x) ? x.a.wcar : 0)), tgtPool = s((x) => x.a.wtgt);
      const rzT = s((x) => x.a.wrz + x.a.wrz10 + x.a.wgl), tdT = s((x) => x.a.rtd + x.a.retd), touT = s((x) => x.a.wcar + x.a.wtgt);
      const rzAll = s((x) => x.a.rz), tgAll = s((x) => x.a.tgt), caAll = s((x) => x.a.car);
      const oppDefOut = tid === H ? X.dA : X.dH;
      const defBoost = 1 + 0.02 * oppDefOut.length;
      const teamTD = implied[tid] * C.tdPerPt * (1 + 0.04 * oppDefOut.length);
      const oRushR = O.g ? (O.oRushTD / O.g) / (LG.rtd || 1) : 1, oRecR = O.g ? (O.oRecTD / O.g) / (LG.ctd || 1) : 1;
      const oYpc = (O.oRushYds + LG.ypc * 80) / (O.oRushAtt + 80) / LG.ypc, oYpa = (O.oPassYds + LG.ypa * 120) / (O.oPassAtt + 120) / LG.ypa;
      const pc = myT && myT.g && O.g ? ((myT.plays / myT.g + O.oplays / O.g) / 2) / LG.plays : 1;
      const tm = tid === H ? m : -m;
      for (const x of skill) {
        const a = x.a, p = x.p;
        const info = rost && rost[p.id];
        const pos = (info && info.pos) || p.pos || (a.att > a.car ? 'QB' : a.car > a.tgt ? 'RB' : 'WR');
        if (['QB'].includes(pos) && a.att < 5 && a.car < 3) continue;
        const nv = lg === 'nfl' && ext.nvInfo ? ext.nvInfo(p.n, ab[tid]) : null;
        // snap trend: playing more (or less) lately changes how much work he gets
        const role = nv && nv.snap >= 0.15 && nv.snapGames >= 3 && nv.snap2 != null ? nv.snap2 / nv.snap : 1;
        const vol = clamp(1 + 0.6 * (role - 1), 0.75, 1.3);
        const extraCar = isBack(x) ? missCar * (a.wcar / carPool) : 0;
        const extraTgt = missTgt * (a.wtgt / tgtPool);
        const rushMix = a.car / ((a.car + a.tgt) || 1);
        let share = 0.5 * (a.wrz + a.wrz10 + a.wgl) / rzT + 0.2 * (a.rtd + a.retd) / tdT + 0.3 * (a.wcar + a.wtgt) / touT;
        if (pos === 'QB') share *= lg === 'cfb' ? 0.55 : 0.45;
        const oadj = clamp(0.7 + 0.3 * (rushMix * oRushR + (1 - rushMix) * oRecR), 0.6, 1.4);
        const lam = teamTD * share * 0.92 * oadj * 0.82 * tdMult * clamp(1 + 0.5 * (vol - 1), 0.85, 1.15);
        const tdP = Math.min(75, Math.round(100 * (1 - Math.exp(-lam))));
        const cpg = (a.wcar / a.wg) * vol + extraCar, tpg = (a.wtgt / a.wg) * vol + extraTgt, apg = a.watt / a.wg;
        // deeper targets earn more yards per catch: use average depth of target when nflverse has it
        const yptBase = nv && nv.adot != null ? clamp(4.5 + 0.35 * nv.adot, 5, 12) : C.ypt;
        const ypc = (a.ry + LG.ypc * 60) / (a.car + 60), ypt = (a.recy + yptBase * 30) / (a.tgt + 30), ypa = (a.py + LG.ypa * 100) / (a.att + 100);
        const rushY = Math.round(cpg * ypc * (0.7 + 0.3 * oYpc) * (1 + 0.015 * tm) * pc * defBoost * (yMult.rush || 1));
        const recY = Math.round(tpg * ypt * (0.7 + 0.3 * oYpa) * (1 - 0.01 * tm) * pc * defBoost * weatherPass * (yMult.rec || 1));
        const passY = pos === 'QB' ? Math.round(apg * ypa * (0.7 + 0.3 * oYpa) * (1 - 0.012 * tm) * pc * defBoost * weatherPass * (yMult.pass || 1)) : 0;
        const od = { rtd: r1(O.g ? O.oRushTD / O.g : 0), ctd: r1(O.g ? O.oRecTD / O.g : 0), ypc: r1(O.oRushYds / (O.oRushAtt || 1)), ypa: r1(O.oPassYds / (O.oPassAtt || 1)), ryg: Math.round(O.g ? O.oRushYds / O.g : 0), pyg: Math.round(O.g ? O.oPassYds / O.g : 0) };
        const rec = {
          id: p.id, n: p.n, pos, t: ab[tid], tid, opp: ab[oid], inj: (info && info.inj) || '', g: a.g,
          td: tdP, lam: +lam.toFixed(3), ry: Math.max(0, rushY), cy: Math.max(0, recY), py: passY,
          s: { car: a.car, ry: a.ry, rtd: a.rtd, tgt: a.tgt, rec: a.rec, recy: a.recy, retd: a.retd, att: a.att, py: a.py, ptd: a.ptd, rz: a.rz, rz10: a.rz10, gl: a.gl },
          tgtEst: !a.tgtKnown, rzS: Math.round((100 * a.rz) / rzAll),
          tgS: nv && nv.tsh != null ? Math.round(100 * nv.tsh) : Math.round((100 * a.tgt) / tgAll), caS: Math.round((100 * a.car) / caAll),
          snap: nv && nv.snap != null ? { season: Math.round(100 * nv.snap), recent: Math.round(100 * (nv.snap2 || nv.snap)) } : null,
          adot: nv && nv.adot != null ? r1(nv.adot) : null, airShare: nv && nv.ash != null ? Math.round(100 * nv.ash) : null,
          boost: (extraCar >= 1 || extraTgt >= 1) && outNames.length ? { car: r1(extraCar), tgt: r1(extraTgt), from: outNames } : null,
          oppDefOut: oppDefOut, weather: weatherPass < 0.99 && (p.pos === 'QB' || a.tgt > a.car) ? { wind: fc && fc.wind, pct: Math.round((1 - weatherPass) * 100) } : null,
          log: a.log, od
        };
        const fx = playerFactors(lg, rec, implied[tid], tm, LG);
        rec.tdF = fx.tdF; rec.yF = fx.yF; rec.kind = pos === 'QB' ? 'pass' : fx.runner ? 'rush' : 'rec';
        P[p.id] = rec;
      }
    }
    const list = Object.values(P);
    G.lists = {
      td: list.filter((p) => p.td >= 8).sort((a, b) => b.td - a.td).slice(0, 8).map((p) => p.id),
      rush: list.filter((p) => p.ry >= 15 && (p.pos !== 'QB' || p.ry >= 25)).sort((a, b) => b.ry - a.ry).slice(0, 4).map((p) => p.id),
      rec: list.filter((p) => p.cy >= 15).sort((a, b) => b.cy - a.cy).slice(0, 6).map((p) => p.id),
      pass: list.filter((p) => p.pos === 'QB' && p.py > 0).sort((a, b) => b.py - a.py).slice(0, 2).map((p) => p.id)
    };
    const keep = new Set([].concat(G.lists.td, G.lists.rush, G.lists.rec, G.lists.pass));
    G.players = {};
    keep.forEach((id) => { G.players[id] = P[id]; });
    // raw (before self-correction) numbers are what grading compares against, so learning doesn't feed on itself
    G.allPlayers = list.map((p) => ({ id: p.id, n: p.n, t: p.t, tid: p.tid, pos: p.pos, kind: p.kind, td: p.td, ry: p.ry, cy: p.cy, py: p.py,
      lr: +(p.lam / tdMult).toFixed(3), ryr: r1(p.ry / (yMult.rush || 1)), cyr: r1(p.cy / (yMult.rec || 1)), pyr: r1(p.py / (yMult.pass || 1)) }));
    games.push(G);
  }

  const leaders = (field, filt, n) => {
    const all = [];
    games.forEach((g) => Object.values(g.players).forEach((p) => { if (filt(p)) all.push({ id: p.id, gid: g.id, n: p.n, pos: p.pos, t: p.t, opp: p.opp, v: p[field] }); }));
    return all.sort((a, b) => b.v - a.v).slice(0, n);
  };
  return {
    games: games.sort((a, b) => String(a.date).localeCompare(String(b.date))),
    leaders: {
      td: leaders('td', () => true, 15), rush: leaders('ry', (p) => p.pos !== 'QB' || p.ry >= 25, 10),
      rec: leaders('cy', () => true, 10), pass: leaders('py', (p) => p.pos === 'QB', 10)
    },
    weight: r1(w), scale: { margin: r1(mScale), totalA: r1(tA0), totalB: +tB.toFixed(2) }
  };
}

function aggPlayer(p) {
  const logs = p.logs.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const ks = ['car', 'ry', 'rtd', 'rec', 'tgt', 'recy', 'retd', 'att', 'cmp', 'py', 'ptd', 'rz', 'rz10', 'gl'];
  const a = { g: logs.length, wg: 0, tgtKnown: logs.some((l) => l.tgtKnown) };
  ks.forEach((k) => { a[k] = 0; a['w' + k] = 0; });
  logs.forEach((l, i) => {
    const wt = i >= logs.length - 2 ? 1.5 : 1;
    a.wg += wt;
    ks.forEach((k) => { a[k] += l[k] || 0; a['w' + k] += (l[k] || 0) * wt; });
  });
  a.log = logs.slice(-3).map((l) => ({ opp: l.oppAb, date: l.date, car: l.car, ry: l.ry, tgt: l.tgt, rec: l.rec, recy: l.recy, td: l.rtd + l.retd, py: l.py, ptd: l.ptd }));
  return a;
}

function gameFactors(lg, G, tH, tA, rt, kH, kA, wet, X = {}) {
  const out = [];
  const sp = G.spread;
  if (!sp) return out;
  const pickHome = sp.teamId === G.home.id;
  const P = pickHome ? G.home : G.away, O = pickHome ? G.away : G.home;
  const kP = pickHome ? kH : kA, kO = pickHome ? kA : kH;
  const fav = G.line.sp < 0 ? G.home.ab : G.away.ab;
  const appFav = G.proj.margin >= 0 ? G.home.ab : G.away.ab;
  const vegasTxt = G.line.sp === 0 ? 'a pick’em' : fav + ' by ' + Math.abs(G.line.sp);
  out.push(f(1, sp.line > 0 ? P.ab + ' is getting ' + sp.line + ' points' : P.ab + ' laying ' + Math.abs(sp.line),
    'Vegas has ' + vegasTxt + ', the app has ' + appFav + ' by ' + Math.abs(G.proj.margin) + '. That gap is the edge.'));
  const rP = rt.power[kP] || 0, rO = rt.power[kO] || 0;
  out.push(f(rP > rO + 1 ? 1 : rP < rO - 1 ? -1 : 0, Math.abs(rP - rO) < 0.5 ? 'Teams rate about even' : rP > rO ? P.ab + ' rates higher' : O.ab + ' rates higher',
    'Strength rating after adjusting for opponents: ' + P.ab + ' ' + (rP >= 0 ? '+' : '') + r1(rP) + ', ' + O.ab + ' ' + (rO >= 0 ? '+' : '') + r1(rO) + '.'));
  if (sp.moved) {
    const mv = sp.moved;
    out.push(f(mv.against ? -1 : 1, 'Line moved ' + mv.by + ' toward ' + mv.toward,
      'Opened at ' + G.home.ab + ' ' + fmtLine(mv.from) + '. ' + (mv.against ? 'The market has moved against this pick' + (sp.confBefore ? ', so confidence drops from ' + sp.confBefore + ' to ' + sp.conf + '.' : '.') : 'The market has moved the same way the app leans.')));
  }
  const sP = P.stats, sO = O.stats;
  if (rt.useEpa && sP && sO && sP.epaO != null && sO.epaO != null) {
    const nP = sP.epaO - sP.epaD, nO = sO.epaO - sO.epaD;
    const fm = (v) => (v >= 0 ? '+' : '') + v.toFixed(2);
    out.push(f(nP > nO + 0.05 ? 1 : nP < nO - 0.05 ? -1 : 0, 'EPA per play', P.ab + ' offense ' + fm(sP.epaO) + ', defense allows ' + fm(sP.epaD) + '. ' + O.ab + ' offense ' + fm(sO.epaO) + ', defense allows ' + fm(sO.epaD) + '.'));
  } else if (sP && sO && sP.yppO != null && sO.yppO != null) {
    const nP = sP.yppO - sP.yppD, nO = sO.yppO - sO.yppD;
    out.push(f(nP > nO + 0.4 ? 1 : nP < nO - 0.4 ? -1 : 0, 'Yards per play', P.ab + ' gains ' + sP.yppO + ' and allows ' + sP.yppD + '. ' + O.ab + ' gains ' + sO.yppO + ' and allows ' + sO.yppD + '.'));
  }
  if (P.qbOut) out.push(f(-1, P.ab + ' without ' + P.qbOut, 'Listed on the injury report as unlikely to play.'));
  const dP = pickHome ? X.dH : X.dA, dO = pickHome ? X.dA : X.dH;
  if (dO && dO.length) out.push(f(1, O.ab + ' missing ' + dO.length + ' key defender' + (dO.length > 1 ? 's' : ''), dO.join(', ') + ' listed out.'));
  if (dP && dP.length) out.push(f(-1, P.ab + ' missing ' + dP.length + ' key defender' + (dP.length > 1 ? 's' : ''), dP.join(', ') + ' listed out.'));
  const dayP = pickHome ? X.restH : X.restA, dayO = pickHome ? X.restA : X.restH;
  const restWord = (d) => (d <= 5.5 ? 'a short week' : d >= 12.5 ? 'a bye' : null);
  if (dayP != null && dayO != null && (restWord(dayP) || restWord(dayO)) && restWord(dayP) !== restWord(dayO)) {
    const better = (dayP >= 12.5 || dayO <= 5.5) && !(dayP <= 5.5);
    out.push(f(better ? 1 : -1, better ? P.ab + ' better rested' : O.ab + ' better rested',
      P.ab + ' had ' + Math.round(dayP) + ' days off' + (restWord(dayP) ? ' (' + restWord(dayP) + ')' : '') + ', ' + O.ab + ' had ' + Math.round(dayO) + (restWord(dayO) ? ' (' + restWord(dayO) + ')' : '') + '.'));
  }
  if (X.travelNote) out.push(f(pickHome ? 1 : -1, 'Travel', X.travelNote + '. Worth about ' + r1(X.travel) + ' points to the home team.'));
  const ps = rt.priorShare ? Math.max(rt.priorShare[kP] || 0, rt.priorShare[kO] || 0) : 0;
  if (ps >= 0.05) out.push(f(0, 'Still using some of last season', 'Last season counts for about ' + Math.round(ps * 100) + '% of these ratings right now. It fades out completely after ' + (lg === 'nfl' ? 8 : 6) + ' games.'));
  if (O.qbOut) out.push(f(1, O.ab + ' without ' + O.qbOut, 'Listed on the injury report as unlikely to play.'));
  if (!G.neutral) {
    const atHome = pickHome;
    out.push(f(atHome ? 1 : -1, G.home.ab + ' at home', 'Home field is worth about ' + CFG[lg].hfa + ' points' + (lg === 'cfb' ? ' in college.' : '.')));
  } else out.push(f(0, 'Neutral site', 'No home field edge for either team.'));
  if (lg === 'cfb') {
    const a = rt.sos[kP] || 0, b = rt.sos[kO] || 0;
    out.push(f(0, 'Strength of schedule', P.ab + '’s opponents rate ' + (a >= 0 ? '+' : '') + r1(a) + ', ' + O.ab + '’s ' + (b >= 0 ? '+' : '') + r1(b) + '. Already built into the ratings.'));
  }
  if (G.indoor) out.push(f(0, 'Indoors', 'No weather effect.'));
  else if (G.forecast) {
    const fc = G.forecast;
    const windy = fc.wind >= 15 || fc.gust >= 25, rainy = fc.rain >= 60;
    out.push(f(0, windy ? 'Windy: ' + fc.wind + ' mph, gusts to ' + fc.gust : rainy ? fc.rain + '% chance of rain' : fc.rain >= 40 ? 'Some rain possible' : 'Good weather',
      'Forecast at kickoff: ' + fc.temp + '°, wind ' + fc.wind + ' mph, ' + fc.rain + '% chance of rain.' + (windy || rainy ? ' Lowers passing and the projected total.' : '')));
  } else if (wet) out.push(f(G.total && G.total.side === 'Under' ? 1 : 0, (G.wx && G.wx.text) + ' in the forecast', 'Wet weather usually lowers scoring a bit.'));
  return out;
}

function playerFactors(lg, p, imp, tm, LG) {
  const L = { imp: LG.pts, rtd: r1(LG.rtd), ctd: r1(LG.ctd), ypc: r1(LG.ypc), ypa: r1(LG.ypa), ryg: Math.round(LG.ryg), pyg: Math.round(LG.pyg) };
  const s = p.s, g = p.g || 1, od = p.od;
  const isRB = p.pos === 'RB' || p.pos === 'FB', isQB = p.pos === 'QB';
  const runner = !isQB && s.car > s.tgt;
  const tdF = [], yF = [];
  const hi = isRB ? 30 : 15, lo = isRB ? 15 : 7;
  tdF.push(f(p.rzS >= hi ? 1 : p.rzS < lo ? -1 : 0, p.rzS >= hi ? 'Owns the red zone' : p.rzS < lo ? 'Rarely used near the goal line' : 'Part of the red zone plan',
    s.rz + (s.rz === 1 ? ' touch' : ' touches') + ' inside the 20 (' + p.rzS + '% of ' + p.t + '’s), ' + s.rz10 + ' inside the 10'));
  if (isRB || isQB) tdF.push(f(s.gl >= 4 ? 1 : s.gl === 0 && isRB ? -1 : 0, s.gl >= 4 ? 'Goal-line back' : s.gl === 0 ? 'No goal-line carries' : 'Some goal-line work', s.gl + (s.gl === 1 ? ' carry' : ' carries') + ' inside the 5 this season'));
  tdF.push(f(imp >= L.imp + 3 ? 1 : imp < L.imp - 3 ? -1 : 0, p.t + ' expected to score ' + r1(imp), 'From the spread and total. More points means more touchdowns to go around.'));
  const allow = runner || isQB ? od.rtd : od.ctd, avgA = runner || isQB ? L.rtd : L.ctd, ratio = avgA ? allow / avgA : 1;
  tdF.push(f(ratio >= 1.25 ? 1 : ratio <= 0.75 ? -1 : 0, p.opp + ' allows ' + allow + (runner || isQB ? ' rushing' : ' receiving') + (allow === 1 ? ' TD a game' : ' TDs a game'), 'League average is about ' + avgA + '.'));
  const tds = s.rtd + s.retd, l2 = sum(p.log.slice(-2), (x) => x.td);
  tdF.push(f(l2 >= 2 ? 1 : 0, tds + ' TD' + (tds === 1 ? '' : 's') + ' in ' + g + ' game' + (g === 1 ? '' : 's'), l2 + ' in the last 2 games'));
  if (p.inj) tdF.push(f(-1, 'Listed ' + p.inj.toLowerCase(), 'Check his status before kickoff. If he sits, his share goes to teammates.'));
  if (p.boost) { const bf = f(1, 'More work with ' + p.boost.from.join(' and ') + ' out', 'About ' + (p.boost.car >= 1 ? '+' + p.boost.car + ' carries' : '') + (p.boost.car >= 1 && p.boost.tgt >= 1 ? ' and ' : '') + (p.boost.tgt >= 1 ? '+' + p.boost.tgt + ' targets' : '') + ' a game from the injured players.'); tdF.push(bf); yF.push(bf); }
  if (p.oppDefOut && p.oppDefOut.length) tdF.push(f(1, p.opp + ' missing ' + p.oppDefOut.join(', '), 'Key defender' + (p.oppDefOut.length > 1 ? 's' : '') + ' listed out.'));
  if (p.snap) { const d = p.snap.recent - p.snap.season; yF.push(f(d >= 8 ? 1 : d <= -8 ? -1 : 0, 'Plays ' + p.snap.recent + '% of snaps lately', 'Season: ' + p.snap.season + '%. ' + (d >= 8 ? 'His role is growing.' : d <= -8 ? 'His role is shrinking.' : 'Steady role.'))); }
  if (p.weather) yF.push(f(-1, 'Wind ' + p.weather.wind + ' mph', 'Cuts about ' + p.weather.pct + '% off passing and receiving yards.'));

  if (isQB) {
    const apg = s.att / g, ypa = s.att ? s.py / s.att : 0;
    yF.push(f(apg >= 35 ? 1 : apg < 26 ? -1 : 0, r1(apg) + ' pass attempts a game', 'Volume matters more than anything for yardage.'));
    yF.push(f(ypa >= L.ypa + 0.7 ? 1 : ypa < L.ypa - 0.7 ? -1 : 0, r1(ypa) + ' yards per attempt', 'League average is about ' + L.ypa + '.'));
    yF.push(f(od.pyg >= L.pyg + 25 ? 1 : od.pyg <= L.pyg - 25 ? -1 : 0, p.opp + ' allows ' + od.pyg + ' passing yards a game', 'League average is about ' + L.pyg + '.'));
    yF.push(f(tm <= -3 ? 1 : tm >= 6 ? -1 : 0, tm < 0 ? p.t + ' projected to trail' : p.t + ' projected to lead', tm < 0 ? 'Teams that fall behind throw more.' : 'Teams with a lead lean on the run late.'));
  } else if (runner) {
    const cpg = s.car / g, ypc = s.car ? s.ry / s.car : 0;
    yF.push(f(p.caS >= 50 ? 1 : p.caS < 25 ? -1 : 0, r1(cpg) + ' carries a game', p.caS + '% of ' + p.t + '’s carries.'));
    yF.push(f(ypc >= L.ypc + 0.5 ? 1 : ypc < L.ypc - 0.5 ? -1 : 0, r1(ypc) + ' yards per carry', 'League average is about ' + L.ypc + '.'));
    yF.push(f(od.ryg >= L.ryg + 20 ? 1 : od.ryg <= L.ryg - 20 ? -1 : 0, p.opp + ' allows ' + od.ryg + ' rushing yards a game', od.ypc + ' per carry. League average is about ' + L.ryg + ' a game.'));
    yF.push(f(tm >= 3 ? 1 : tm <= -6 ? -1 : 0, tm >= 0 ? p.t + ' projected to lead' : p.t + ' projected to trail', tm >= 0 ? 'Teams with a lead run more late in games.' : 'Teams that fall behind run less.'));
  } else {
    const tpg = s.tgt / g, ypt = s.tgt ? s.recy / s.tgt : 0;
    yF.push(f(p.tgS >= 25 ? 1 : p.tgS < 15 ? -1 : 0, r1(tpg) + ' targets a game', p.tgS + '% of ' + p.t + '’s targets' + (p.tgtEst ? ' (estimated from catches)' : '') + '.'));
    yF.push(f(ypt >= 9 ? 1 : ypt < 7 ? -1 : 0, r1(ypt) + ' yards per target', 'Receivers average about 8.' + (p.adot != null ? ' Average target ' + p.adot + ' yards downfield' + (p.airShare != null ? ', ' + p.airShare + '% of the team\u2019s air yards.' : '.') : '')));
    yF.push(f(od.pyg >= L.pyg + 25 ? 1 : od.pyg <= L.pyg - 25 ? -1 : 0, p.opp + ' allows ' + od.pyg + ' passing yards a game', od.ypa + ' per pass. League average is about ' + L.pyg + ' a game.'));
    yF.push(f(tm <= -3 ? 1 : tm >= 6 ? -1 : 0, tm < 0 ? p.t + ' projected to trail' : p.t + ' projected to lead', tm < 0 ? 'Teams that fall behind throw more.' : 'A big lead can mean fewer throws late.'));
  }
  const last2 = p.log.slice(-2);
  const proj = isQB ? p.py : runner ? p.ry : p.cy;
  const l2y = last2.length ? sum(last2, (x) => (isQB ? x.py : runner ? x.ry : x.recy)) / last2.length : 0;
  yF.push(f(proj && l2y >= proj * 1.2 ? 1 : proj && l2y <= proj * 0.7 ? -1 : 0, 'Last ' + last2.length + ' games: ' + Math.round(l2y) + ' a game', 'Recent games count 1.5 times as much as earlier ones.'));
  return { tdF, yF, runner };
}

module.exports = { CFG, buildTables, ratings, buildSlate, teamStats, lineFromEvent };
