// Football model: opponent-adjusted team ratings, spread / total / winner picks,
// anytime-TD chances and yardage projections, plus the reasons behind each.

const CFG = {
  nfl: { hfa: 1.7, cap: 17, strong: 2.5, solid: 1.2, qbOut: 3, tdPerPt: 1 / 9.8, ypt: 8.0 },
  cfb: { hfa: 2.7, cap: 24, strong: 3.0, solid: 1.5, qbOut: 0, tdPerPt: 1 / 9.5, ypt: 8.5 }
};
const OUT = /out|injured reserve|doubtful|suspen|pup/i;

const r1 = (x) => Math.round(x * 10) / 10;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const softCap = (m, X) => { const a = Math.abs(m); return Math.sign(m) * (a <= X ? a : X + 0.3 * (a - X)); };
const fmtLine = (n) => (n === 0 ? 'PK' : n > 0 ? '+' + n : '' + n);
const f = (v, title, detail) => ({ v, title, detail });

// ---------- season tables from finished games ----------
function buildTables(lg, gamesList, fbs) {
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
      if (ot) { ot.oRushTD += p.rtd; ot.oRecTD += p.retd; }
      const rec = players[p.id] || (players[p.id] = { id: p.id, n: p.n, pos: p.pos, t: p.t, logs: [] });
      rec.n = p.n; rec.t = p.t; if (p.pos) rec.pos = p.pos;
      rec.logs.push({ ...p, gid: g.id, date: g.date, opp: opp.id, oppAb: opp.ab, tgtKnown: g.tgtKnown });
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
  return { T, players, LG, key, done };
}

// Opponent-adjusted ratings (iterative ridge): margin, yards per play, points.
function ratings(lg, tables) {
  const { T, LG } = tables;
  const C = CFG[lg];
  const ids = Object.keys(T);
  const r = {}, off = {}, def = {}, po = {}, pd = {};
  ids.forEach((id) => { r[id] = 0; off[id] = 0; def[id] = 0; po[id] = 0; pd[id] = 0; });
  const lam = 2;
  for (let it = 0; it < 60; it++) {
    for (const id of ids) {
      const t = T[id]; let s1 = 0, s2 = 0, s3 = 0, s4 = 0, s5 = 0, n = 0, ny = 0;
      for (const g of t.games) {
        const h = g.neutral ? 0 : (g.home ? C.hfa : -C.hfa);
        s1 += softCap(g.pf - g.pa, C.cap) - h + (r[g.opp] || 0);
        s4 += g.pf - LG.pts - (pd[g.opp] || 0);
        s5 += g.pa - LG.pts - (po[g.opp] || 0);
        if (g.ypp != null && g.oypp != null) { s2 += g.ypp - LG.ypp - (def[g.opp] || 0); s3 += g.oypp - LG.ypp - (off[g.opp] || 0); ny++; }
        n++;
      }
      r[id] = s1 / (n + lam); po[id] = s4 / (n + lam); pd[id] = s5 / (n + lam);
      off[id] = ny ? s2 / (ny + lam) : 0; def[id] = ny ? s3 / (ny + lam) : 0;
    }
  }
  const power = {}, sos = {};
  for (const id of ids) {
    const t = T[id];
    const toM = t.g ? (t.tk - t.to) / t.g : 0;
    power[id] = 0.55 * r[id] + 0.45 * 6.5 * (off[id] - def[id]) - 0.25 * 4 * toM;
    sos[id] = t.g ? sum(t.games, (g) => r[g.opp] || 0) / t.g : 0;
  }
  return { r, off, def, po, pd, power, sos };
}

function teamStats(t) {
  if (!t || !t.g) return null;
  return {
    g: t.g, ppg: r1(t.pf / t.g), pa: r1(t.pa / t.g), diff: r1((t.pf - t.pa) / t.g),
    yppO: t.plays ? r1(t.yds / t.plays) : null, yppD: t.oplays ? r1(t.oyds / t.oplays) : null,
    toM: t.tk - t.to, t3: t.t3a ? Math.round((100 * t.t3c) / t.t3a) : null,
    rz: t.rzKnown && t.rzA ? Math.round((100 * t.rzTD) / t.rzA) : null
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
  return { sp, ou: typeof o.overUnder === 'number' ? o.overUnder : null, details, book: (o.provider && o.provider.name) || '' };
}

function buildSlate(lg, sb, tables, rt, rost, calib) {
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
    const wet = !indoor && wx && /rain|snow|storm|shower/i.test(wx.text);
    const qH = C.qbOut ? qbOut(H) : null, qA = C.qbOut ? qbOut(A) : null;
    const pw = (k) => rt.power[k] || 0;
    const rawM = pw(kH) - pw(kA) + hfa + (qA ? C.qbOut : 0) - (qH ? C.qbOut : 0);
    const ptsFor = (o, d) => LG.pts + (rt.po[o] || 0) + (rt.pd[d] || 0);
    const pace = tH && tA && tH.g && tA.g ? ((tH.plays / tH.g + tA.plays / tA.g) / 2) / LG.plays : 1;
    const rawT = (ptsFor(kH, kA) + ptsFor(kA, kH)) * (0.85 + 0.15 * pace) - (wet ? 1.5 : 0);
    return { c, hc, ac, H, A, kH, kA, tH, tA, neutral, hfa, line, indoor, wx, wet, qH, qA, rawM, rawT };
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
    const { c, hc, ac, H, A, kH, kA, tH, tA, neutral, line, indoor, wx, wet, qH, qA } = X;
    const e = (sb.events || []).find((ev) => ev.competitions[0] === c);
    const status = (e.status && e.status.type) || {};
    const rawM = X.rawM * mScale, rawT = tA0 + tB * X.rawT;
    const m = line.sp != null ? w * rawM + (1 - w) * -line.sp : rawM;
    const tt = line.ou != null ? w * rawT + (1 - w) * line.ou : rawT;
    const conf = (x) => (Math.abs(x) >= C.strong ? 'Strong' : Math.abs(x) >= C.solid ? 'Solid' : 'Lean');
    const ab = { [H]: hc.team.abbreviation, [A]: ac.team.abbreviation };
    let spread = null, total = null;
    if (line.sp != null) {
      const edge = m + line.sp, homeSide = edge > 0;
      const team = homeSide ? H : A, ln = homeSide ? line.sp : -line.sp;
      spread = { team: ab[team], teamId: team, line: ln, label: ab[team] + ' ' + fmtLine(ln), edge: r1(Math.abs(edge)), conf: conf(edge) };
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
      venue: (c.venue && c.venue.fullName) || '', indoor, neutral, wx,
      away: team(ac, kA, qA), home: team(hc, kH, qH), line,
      proj: { margin: r1(m), total: r1(tt), home: Math.round(hPts), away: Math.round(aPts), winner: m >= 0 ? ab[H] : ab[A],
        winPct: Math.round(100 / (1 + Math.exp(-Math.abs(m) / (lg === 'cfb' ? 7 : 6.5)))), rawMargin: r1(rawM), rawTotal: r1(rawT), weight: r1(w) },
      spread, total, implied: { [ab[H]]: r1(implied[H]), [ab[A]]: r1(implied[A]) }
    };
    G.factors = gameFactors(lg, G, tH, tA, rt, kH, kA, wet);

    // players
    const P = {};
    for (const [tid, oid] of [[H, A], [A, H]]) {
      const O = T[key(oid)] || { g: 1, oRushTD: 0, oRecTD: 0, oRushYds: 0, oRushAtt: 1, oPassYds: 0, oPassAtt: 1, oplays: 0 };
      const myT = T[key(tid)];
      const recent = myT ? myT.games.map((x) => x.date).sort().slice(-3)[0] : null;
      const skill = Object.values(players).filter((p) => p.t === tid && (!recent || p.logs[p.logs.length - 1].date >= recent))
        .filter((p) => !(rost && rost[p.id] && OUT.test(rost[p.id].inj || '')))
        .map((p) => ({ p, a: aggPlayer(p) })).filter((x) => x.a.car + x.a.tgt > 0);
      if (!skill.length) continue;
      const s = (fn) => sum(skill, fn) || 1;
      const rzT = s((x) => x.a.wrz + x.a.wrz10 + x.a.wgl), tdT = s((x) => x.a.rtd + x.a.retd), touT = s((x) => x.a.wcar + x.a.wtgt);
      const rzAll = s((x) => x.a.rz), tgAll = s((x) => x.a.tgt), caAll = s((x) => x.a.car);
      const teamTD = implied[tid] * C.tdPerPt;
      const oRushR = O.g ? (O.oRushTD / O.g) / (LG.rtd || 1) : 1, oRecR = O.g ? (O.oRecTD / O.g) / (LG.ctd || 1) : 1;
      const oYpc = (O.oRushYds + LG.ypc * 80) / (O.oRushAtt + 80) / LG.ypc, oYpa = (O.oPassYds + LG.ypa * 120) / (O.oPassAtt + 120) / LG.ypa;
      const pc = myT && myT.g && O.g ? ((myT.plays / myT.g + O.oplays / O.g) / 2) / LG.plays : 1;
      const tm = tid === H ? m : -m;
      for (const x of skill) {
        const a = x.a, p = x.p;
        const info = rost && rost[p.id];
        const pos = (info && info.pos) || p.pos || (a.att > a.car ? 'QB' : a.car > a.tgt ? 'RB' : 'WR');
        if (['QB'].includes(pos) && a.att < 5 && a.car < 3) continue;
        const rushMix = a.car / ((a.car + a.tgt) || 1);
        let share = 0.5 * (a.wrz + a.wrz10 + a.wgl) / rzT + 0.2 * (a.rtd + a.retd) / tdT + 0.3 * (a.wcar + a.wtgt) / touT;
        if (pos === 'QB') share *= lg === 'cfb' ? 0.55 : 0.45;
        const oadj = clamp(0.7 + 0.3 * (rushMix * oRushR + (1 - rushMix) * oRecR), 0.6, 1.4);
        const lam = teamTD * share * 0.92 * oadj * 0.82 * tdMult;
        const tdP = Math.min(75, Math.round(100 * (1 - Math.exp(-lam))));
        const cpg = a.wcar / a.wg, tpg = a.wtgt / a.wg, apg = a.watt / a.wg;
        const ypc = (a.ry + LG.ypc * 60) / (a.car + 60), ypt = (a.recy + C.ypt * 30) / (a.tgt + 30), ypa = (a.py + LG.ypa * 100) / (a.att + 100);
        const rushY = Math.round(cpg * ypc * (0.7 + 0.3 * oYpc) * (1 + 0.015 * tm) * pc * (yMult.rush || 1));
        const recY = Math.round(tpg * ypt * (0.7 + 0.3 * oYpa) * (1 - 0.01 * tm) * pc * (yMult.rec || 1));
        const passY = pos === 'QB' ? Math.round(apg * ypa * (0.7 + 0.3 * oYpa) * (1 - 0.012 * tm) * pc * (yMult.pass || 1)) : 0;
        const od = { rtd: r1(O.g ? O.oRushTD / O.g : 0), ctd: r1(O.g ? O.oRecTD / O.g : 0), ypc: r1(O.oRushYds / (O.oRushAtt || 1)), ypa: r1(O.oPassYds / (O.oPassAtt || 1)), ryg: Math.round(O.g ? O.oRushYds / O.g : 0), pyg: Math.round(O.g ? O.oPassYds / O.g : 0) };
        const rec = {
          id: p.id, n: p.n, pos, t: ab[tid], tid, opp: ab[oid], inj: (info && info.inj) || '', g: a.g,
          td: tdP, lam: +lam.toFixed(3), ry: Math.max(0, rushY), cy: Math.max(0, recY), py: passY,
          s: { car: a.car, ry: a.ry, rtd: a.rtd, tgt: a.tgt, rec: a.rec, recy: a.recy, retd: a.retd, att: a.att, py: a.py, ptd: a.ptd, rz: a.rz, rz10: a.rz10, gl: a.gl },
          tgtEst: !a.tgtKnown, rzS: Math.round((100 * a.rz) / rzAll), tgS: Math.round((100 * a.tgt) / tgAll), caS: Math.round((100 * a.car) / caAll),
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

function gameFactors(lg, G, tH, tA, rt, kH, kA, wet) {
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
  const sP = P.stats, sO = O.stats;
  if (sP && sO && sP.yppO != null && sO.yppO != null) {
    const nP = sP.yppO - sP.yppD, nO = sO.yppO - sO.yppD;
    out.push(f(nP > nO + 0.4 ? 1 : nP < nO - 0.4 ? -1 : 0, 'Yards per play', P.ab + ' gains ' + sP.yppO + ' and allows ' + sP.yppD + '. ' + O.ab + ' gains ' + sO.yppO + ' and allows ' + sO.yppD + '.'));
  }
  if (P.qbOut) out.push(f(-1, P.ab + ' without ' + P.qbOut, 'Listed on the injury report as unlikely to play.'));
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
  else if (wet) out.push(f(G.total && G.total.side === 'Under' ? 1 : 0, G.wx.text + ' in the forecast', 'Wet weather usually lowers scoring a bit.'));
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
    yF.push(f(ypt >= 9 ? 1 : ypt < 7 ? -1 : 0, r1(ypt) + ' yards per target', 'Receivers average about 8.'));
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
