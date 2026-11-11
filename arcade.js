'use strict';
/* Server-side simulations for the real-time two-player games.
   Each sim exposes step(inputs, dt), view() and an `over` result once finished.
   inputs = [seat0, seat1], each { l, r, u, d, a, b, c } booleans. */

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------------- Slam Night: wrestling brawler ---------------- */
function createBrawl() {
  const W = 800;
  const ATK = {
    a: { st: 'punch', dur: 0.28, hitAt: 0.14, range: 80, dmg: 6, kb: 26 },
    b: { st: 'kick', dur: 0.46, hitAt: 0.24, range: 106, dmg: 10, kb: 60 },
  };
  const mk = (x, face) => ({ x, y: 0, vy: 0, face, hp: 100, st: 'idle', t: 0, atk: null, m: 0, w: 0, prev: {} });
  const f = [mk(250, 1), mk(550, -1)];
  const s = { time: 60, round: 1, pause: 1.6, ending: false, rw: -1, msg: 'Round 1', over: null };

  function resetRound() {
    f.forEach((p, i) => Object.assign(p, { x: i ? 550 : 250, y: 0, vy: 0, face: i ? -1 : 1, hp: 100, st: 'idle', t: 0, atk: null }));
    s.time = 60;
  }
  function strike(p, o, A) {
    const dx = (o.x - p.x) * p.face;
    if (dx < -10 || dx > A.range || Math.abs(o.y - p.y) > 80 || o.st === 'down') return;
    if (o.st === 'block' && o.face === -p.face) {
      o.hp = Math.max(0, o.hp - A.dmg * 0.2);
      o.x = clamp(o.x + p.face * 10, 50, W - 50);
      p.m = Math.min(100, p.m + 3);
    } else {
      o.hp = Math.max(0, o.hp - A.dmg);
      o.st = 'hit'; o.t = 0.26; o.atk = null;
      o.x = clamp(o.x + p.face * A.kb, 50, W - 50);
      p.m = Math.min(100, p.m + A.dmg * 2.2);
      o.m = Math.min(100, o.m + A.dmg);
    }
  }
  function act(i, inp, dt) {
    const p = f[i], o = f[1 - i], prev = p.prev;
    p.prev = inp;
    if (p.t > 0) {
      p.t -= dt;
      if (p.atk && !p.atk.done && p.t <= p.atk.dur - p.atk.hitAt) { p.atk.done = true; strike(p, o, p.atk); }
      if (p.t <= 0) { p.st = 'idle'; p.atk = null; } else if (p.st !== 'block') return;
    }
    const grounded = p.y <= 0;
    if (grounded && Math.abs(o.x - p.x) > 1) p.face = o.x > p.x ? 1 : -1;
    if (inp.d && grounded) { p.st = 'block'; p.t = 0.05; return; }
    const dir = (inp.r ? 1 : 0) - (inp.l ? 1 : 0);
    p.x = clamp(p.x + dir * 230 * dt, 50, W - 50);
    p.st = !grounded ? 'jump' : dir ? 'walk' : 'idle';
    if (!grounded) return;
    if (inp.u && !prev.u) { p.vy = 560; p.y = 1; return; }
    for (const k of ['a', 'b']) {
      if (inp[k] && !prev[k]) { const A = ATK[k]; p.st = A.st; p.t = A.dur; p.atk = { ...A, done: false }; return; }
    }
    if (inp.c && !prev.c && p.m >= 100 && Math.abs(o.x - p.x) < 95 && o.y <= 0 && o.st !== 'down') {
      p.m = 0; p.st = 'slam'; p.t = 0.6;
      o.hp = Math.max(0, o.hp - 26); o.st = 'down'; o.t = 1.3; o.atk = null;
      o.x = clamp(p.x + p.face * 80, 50, W - 50); o.y = 1; o.vy = 430;
    }
  }
  function settle(dt) {
    for (const p of f) {
      if (p.y > 0 || p.vy > 0) {
        p.vy -= 1500 * dt; p.y += p.vy * dt;
        if (p.y <= 0) { p.y = 0; p.vy = 0; }
      }
      if (p.hp <= 0) { p.st = 'down'; p.t = 5; }
    }
    const dx = f[1].x - f[0].x;
    if (Math.abs(dx) < 56 && f[0].y < 40 && f[1].y < 40) {
      const push = (56 - Math.abs(dx)) / 2 * (dx >= 0 ? 1 : -1);
      f[0].x = clamp(f[0].x - push, 50, W - 50);
      f[1].x = clamp(f[1].x + push, 50, W - 50);
    }
  }
  function endRound(winner) {
    if (winner >= 0) f[winner].w++;
    s.rw = winner; s.ending = true; s.pause = 2.6;
    s.msg = winner >= 0 ? 'KO' : 'Time';
  }
  function step(inputs, dt) {
    if (s.over) return;
    if (s.pause > 0) {
      s.pause -= dt;
      settle(dt);
      if (s.pause <= 0) {
        if (s.ending) {
          s.ending = false;
          const champ = f.findIndex((p) => p.w >= 2);
          if (champ >= 0) { s.over = { winner: champ }; return; }
          s.round++; resetRound(); s.msg = 'Round ' + s.round; s.pause = 1.6;
        } else s.msg = '';
      }
      return;
    }
    s.time -= dt;
    act(0, inputs[0] || {}, dt);
    act(1, inputs[1] || {}, dt);
    settle(dt);
    if (f[0].hp <= 0 || f[1].hp <= 0) endRound(f[0].hp <= 0 ? (f[1].hp <= 0 ? -1 : 1) : 0);
    else if (s.time <= 0) endRound(f[0].hp === f[1].hp ? -1 : f[0].hp > f[1].hp ? 0 : 1);
  }
  function view() {
    return {
      k: 'brawl', time: Math.ceil(Math.max(0, s.time)), msg: s.msg, rw: s.ending ? s.rw : null,
      f: f.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y), face: p.face, hp: Math.round(p.hp), st: p.st, m: Math.round(p.m), w: p.w })),
    };
  }
  return { step, view, get over() { return s.over; } };
}

/* ---------------- Kickoff: 3-a-side football ---------------- */
function createKick() {
  const W = 900, H = 560, GY0 = 205, GY1 = 355, PR = 14, BR = 8;
  const HOME = [[[40, 280], [300, 200], [300, 360]], [[860, 280], [600, 200], [600, 360]]];
  const P = [0, 1].map((t) => HOME[t].map(([x, y]) => ({ x, y, fx: t ? -1 : 1, fy: 0, cd: 0 })));
  const ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  const s = { score: [0, 0], time: 150, pause: 1.6, owner: null, ctrl: [1, 1], msg: 'Kick off!', over: null };
  const prev = [{}, {}];
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  function kickoff() {
    P.forEach((team, t) => team.forEach((p, i) => Object.assign(p, { x: HOME[t][i][0], y: HOME[t][i][1], fx: t ? -1 : 1, fy: 0, cd: 0 })));
    Object.assign(ball, { x: W / 2, y: H / 2, vx: 0, vy: 0 });
    s.owner = null;
  }
  function moveTo(p, tx, ty, speed, dt) {
    const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
    if (d < 2) return;
    p.fx = dx / d; p.fy = dy / d;
    const stepLen = Math.min(d, speed * dt);
    p.x += p.fx * stepLen; p.y += p.fy * stepLen;
  }
  function launch(p, dx, dy, speed) {
    const d = Math.hypot(dx, dy) || 1;
    ball.x = p.x + (dx / d) * (PR + BR + 2); ball.y = p.y + (dy / d) * (PR + BR + 2);
    ball.vx = (dx / d) * speed; ball.vy = (dy / d) * speed;
    p.cd = 0.35; s.owner = null;
  }
  function goal(team) {
    s.score[team]++; s.msg = 'GOAL!'; s.pause = 1.8;
    kickoff();
  }
  function step(inputs, dt) {
    if (s.over) return;
    if (s.pause > 0) { s.pause -= dt; if (s.pause <= 0) s.msg = ''; return; }
    s.time -= dt;
    if (s.time <= 0) {
      s.over = { winner: s.score[0] === s.score[1] ? 'draw' : s.score[0] > s.score[1] ? 0 : 1, score: s.score.slice() };
      return;
    }
    for (let t = 0; t < 2; t++) {
      const team = P[t], inp = inputs[t] || {}, pv = prev[t];
      prev[t] = inp;
      const has = (i) => s.owner && s.owner.t === t && s.owner.i === i;
      // which outfielder the human drives: the ball carrier, else the one clearly nearer the ball
      if (s.owner && s.owner.t === t && s.owner.i > 0) s.ctrl[t] = s.owner.i;
      else {
        const cur = s.ctrl[t], other = cur === 1 ? 2 : 1;
        if (dist(team[other], ball) + 40 < dist(team[cur], ball)) s.ctrl[t] = other;
      }
      const ownGoalX = t ? W : 0, fwd = t ? -1 : 1;
      team.forEach((p, i) => {
        p.cd = Math.max(0, p.cd - dt);
        if (i === 0) { // goalkeeper
          const near = dist(p, ball) < 110 && Math.abs(ball.x - ownGoalX) < 150;
          if (near) moveTo(p, clamp(ball.x, ownGoalX - 100, ownGoalX + 100), ball.y, 185, dt);
          else moveTo(p, ownGoalX + fwd * 30, clamp(ball.y, GY0 + 10, GY1 - 10), 175, dt);
          if (has(0)) { const mate = team[s.ctrl[t]]; launch(p, mate.x - p.x + fwd * 60, mate.y - p.y, 430); p.cd = 0.6; }
        } else if (i === s.ctrl[t]) { // human
          const dx = (inp.r ? 1 : 0) - (inp.l ? 1 : 0), dy = (inp.d ? 1 : 0) - (inp.u ? 1 : 0);
          const len = Math.hypot(dx, dy);
          if (len) { p.fx = dx / len; p.fy = dy / len; p.x += p.fx * 195 * dt; p.y += p.fy * 195 * dt; }
          if (has(i)) {
            if (inp.a && !pv.a) launch(p, p.fx, p.fy, 540);
            else if (inp.b && !pv.b) { const mate = team[i === 1 ? 2 : 1]; launch(p, mate.x - p.x, mate.y - p.y, 400); }
          }
        } else if (s.owner && s.owner.t === t) { // AI team-mate: offer a pass
          moveTo(p, clamp(ball.x + fwd * 150, 60, W - 60), ball.y < H / 2 ? 400 : 160, 150, dt);
        } else { // AI team-mate: cover
          moveTo(p, ownGoalX + (ball.x - ownGoalX) * 0.6, H / 2 + (ball.y - H / 2) * 0.5, 150, dt);
        }
        p.x = clamp(p.x, 5, W - 5); p.y = clamp(p.y, PR, H - PR);
      });
    }
    // keep players from overlapping
    const all = [...P[0], ...P[1]];
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
      const dx = all[b].x - all[a].x, dy = all[b].y - all[a].y, d = Math.hypot(dx, dy) || 0.01;
      if (d < PR * 2) {
        const push = (PR * 2 - d) / 2;
        all[a].x -= (dx / d) * push; all[a].y -= (dy / d) * push;
        all[b].x += (dx / d) * push; all[b].y += (dy / d) * push;
      }
    }
    // ball
    const inMouth = ball.y > GY0 && ball.y < GY1;
    if (s.owner) {
      const o = P[s.owner.t][s.owner.i];
      ball.x = o.x + o.fx * (PR + BR); ball.y = o.y + o.fy * (PR + BR); ball.vx = ball.vy = 0;
      const rival = P[1 - s.owner.t].findIndex((p) => p.cd === 0 && dist(p, ball) < PR + BR + 2);
      if (rival >= 0) { o.cd = 0.5; s.owner = { t: 1 - s.owner.t, i: rival }; }
    } else {
      ball.x += ball.vx * dt; ball.y += ball.vy * dt;
      const fr = Math.pow(0.985, dt * 60);
      ball.vx *= fr; ball.vy *= fr;
      if (ball.y < BR) { ball.y = BR; ball.vy = Math.abs(ball.vy); }
      if (ball.y > H - BR) { ball.y = H - BR; ball.vy = -Math.abs(ball.vy); }
      if (!inMouth) {
        if (ball.x < BR) { ball.x = BR; ball.vx = Math.abs(ball.vx); }
        if (ball.x > W - BR) { ball.x = W - BR; ball.vx = -Math.abs(ball.vx); }
      }
      let best = null, bestD = PR + BR + 3;
      P.forEach((team, t) => team.forEach((p, i) => {
        const d = dist(p, ball);
        if (p.cd === 0 && d < bestD) { bestD = d; best = { t, i }; }
      }));
      if (best) s.owner = best;
    }
    if (ball.y > GY0 && ball.y < GY1) {
      if (ball.x < -BR + 1) goal(1);
      else if (ball.x > W + BR - 1) goal(0);
    }
  }
  function view() {
    return {
      k: 'kick', p: P.map((team) => team.map((p) => [Math.round(p.x), Math.round(p.y)])), c: s.ctrl,
      b: [Math.round(ball.x), Math.round(ball.y)], s: s.score, t: Math.ceil(Math.max(0, s.time)), msg: s.msg,
    };
  }
  return { step, view, get over() { return s.over; } };
}

const FACTORY = { brawl: createBrawl, kick: createKick };
module.exports = { TYPES: Object.keys(FACTORY), create: (type) => FACTORY[type]() };
