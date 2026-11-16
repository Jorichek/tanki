'use strict';
const http = require('http'), fs = require('fs'), path = require('path');
const { WebSocketServer } = require('ws');
const PORT = process.env.PORT || 3000, INDEX = path.join(__dirname, 'index.html');

const server = http.createServer((q, s) => {
  if (q.url === '/healthz') { s.writeHead(200); return s.end('ok'); }
  fs.readFile(INDEX, (e, d) => {
    if (e) { s.writeHead(500); return s.end('index.html not found'); }
    s.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); s.end(d);
  });
});

const W = 1600, H = 880, CELL = 40, COLS = 40, ROWS = 22, N = COLS * ROWS;
const R = 14, BR = 4, DT = 1 / 60, MAXP = 10;
const rnd = n => Math.floor(Math.random() * n), r1 = v => Math.round(v * 10) / 10, r0 = Math.round;
const ABKEYS = ['ricochet', 'triple', 'vampire', 'regen', 'armor', 'rapid', 'pierce', 'dash', 'shield', 'mine'];
const THEMES = ['dawn', 'night', 'acid', 'dune', 'neon'];
// тайлы: 0 пусто, 1 стена, 2 ящик (ломается), 3 вода (танк не проедет, снаряд пролетит), 4 куст, 5 бочка (взрывается)

// Случайные, но сбалансированные характеристики (сумма логарифмических отклонений = 0) + выбранная способность
function rollStats(ab) {
  const amp = [0.3, 0.3, 0.3, 0.2, 0.15, 0.15];
  const r = amp.map(a => (Math.random() * 2 - 1) * a), m = r.reduce((a, b) => a + b, 0) / r.length;
  const f = r.map(v => Math.exp(v - m));
  const s = { hp: Math.round(100 * f[0]), speed: 190 * f[1], turn: 3 * f[2], dmg: 20 * f[3], reload: 0.45 / f[4], bspeed: 580 * f[5],
    ab, shots: 1, bounces: 0, vamp: 0, regen: 0, armor: 1, pierce: 0, act: 0, acd: 0 };
  switch (ab) {
    case 'ricochet': s.bounces = 3; s.dmg *= 0.85; break;
    case 'triple': s.shots = 3; s.dmg *= 0.45; s.reload *= 1.15; break;
    case 'vampire': s.vamp = 0.4; break;
    case 'regen': s.regen = 4; break;
    case 'armor': s.armor = 0.72; s.speed *= 0.93; break;
    case 'rapid': s.reload *= 0.55; s.dmg *= 0.7; break;
    case 'pierce': s.pierce = 1; s.dmg *= 0.85; break;
    case 'dash': s.act = 1; s.acd = 2.5; break;
    case 'shield': s.act = 1; s.acd = 8; break;
    case 'mine': s.act = 1; s.acd = 4; break;
  }
  return s;
}

// ---------- Карта ----------
function genMap() {
  const g = new Uint8Array(N), target = N * (0.12 + Math.random() * 0.1);
  let n = 0;
  for (let k = 0; n < target && k < 500; k++) {
    let w = 1 + rnd(4), h = 1 + rnd(4);
    if (Math.random() < 0.35) { w = 1 + rnd(7); h = 1; if (Math.random() < 0.5) [w, h] = [h, w]; }
    const x0 = rnd(COLS - w + 1), y0 = rnd(ROWS - h + 1);
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (!g[y * COLS + x]) { g[y * COLS + x] = 1; n++; }
  }
  for (let k = 2 + rnd(3); k--;) { // пруды
    const cx = rnd(COLS), cy = rnd(ROWS), a = 1.5 + Math.random() * 2.5, b = 1.2 + Math.random() * 2;
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++)
      if (((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 < 1 + (Math.random() - 0.5) * 0.5) g[y * COLS + x] = 3;
  }
  // связность: всё, что недостижимо для танка, превращаем в стену
  const pass = i => g[i] !== 1 && g[i] !== 3;
  const comp = new Int16Array(N).fill(-1);
  let best = -1, bestSize = 0, id = 0;
  for (let s = 0; s < N; s++) {
    if (!pass(s) || comp[s] >= 0) continue;
    const st = [s]; comp[s] = id; let size = 0;
    while (st.length) {
      const c = st.pop(); size++;
      const x = c % COLS, y = (c / COLS) | 0;
      for (const q of [x > 0 ? c - 1 : -1, x < COLS - 1 ? c + 1 : -1, y > 0 ? c - COLS : -1, y < ROWS - 1 ? c + COLS : -1])
        if (q >= 0 && pass(q) && comp[q] < 0) { comp[q] = id; st.push(q); }
    }
    if (size > bestSize) { bestSize = size; best = id; }
    id++;
  }
  const free = [];
  for (let i = 0; i < N; i++) if (pass(i)) { if (comp[i] !== best) g[i] = 1; else free.push(i); }
  for (const i of free) { const q = Math.random(); if (q < 0.07) g[i] = 2; else if (q < 0.085) g[i] = 5; }
  for (let k = 5 + rnd(5); k--;) { // кусты
    const c = free[rnd(free.length)], cx = c % COLS, cy = (c / COLS) | 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -2; dx <= 2; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x >= 0 && y >= 0 && x < COLS && y < ROWS && g[y * COLS + x] === 0 && Math.random() < 0.7) g[y * COLS + x] = 4;
    }
  }
  return { g, free: free.filter(i => g[i] === 0 || g[i] === 4) };
}

function pickSpawns(free, n) {
  const pts = [], cx = c => (c % COLS) * CELL + CELL / 2, cy = c => ((c / COLS) | 0) * CELL + CELL / 2;
  pts.push(free[rnd(free.length)]);
  while (pts.length < n) {
    let bc = free[0], bd = -1;
    for (const c of free) {
      let md = Infinity;
      for (const p of pts) md = Math.min(md, (cx(c) - cx(p)) ** 2 + (cy(c) - cy(p)) ** 2);
      md += Math.random() * 4000;
      if (md > bd) { bd = md; bc = c; }
    }
    pts.push(bc);
  }
  return pts;
}

const SOLID = v => v === 1 || v === 2 || v === 3 || v === 5;
function blocked(g, x, y) {
  if (x < R || y < R || x > W - R || y > H - R) return true;
  const x0 = Math.floor((x - R) / CELL), x1 = Math.min(COLS - 1, Math.floor((x + R) / CELL));
  const y0 = Math.floor((y - R) / CELL), y1 = Math.min(ROWS - 1, Math.floor((y + R) / CELL));
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    if (!SOLID(g[cy * COLS + cx])) continue;
    const nx = Math.max(cx * CELL, Math.min(x, cx * CELL + CELL)), ny = Math.max(cy * CELL, Math.min(y, cy * CELL + CELL));
    if ((x - nx) ** 2 + (y - ny) ** 2 < R * R) return true;
  }
  return false;
}
// что встретит снаряд: 0 ничего, 1 стена, 2 ящик, 5 бочка (вода и кусты снаряд не останавливают)
const hit = (g, x, y) => { if (x < 0 || y < 0 || x >= W || y >= H) return 1; const i = ((y / CELL) | 0) * COLS + ((x / CELL) | 0), v = g[i]; return v === 1 || v === 2 || v === 5 ? v : 0; };

// ---------- Комнаты ----------
const rooms = new Map();
let nextId = 1;
const send = (ws, m) => { if (ws.readyState === 1) ws.send(JSON.stringify(m)); };
function broadcast(room, m) {
  const s = JSON.stringify(m);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(s);
}
function newRoom() {
  const L = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let code;
  do { code = ''; for (let i = 0; i < 4; i++) code += L[rnd(L.length)]; } while (rooms.has(code));
  const r = { code, players: new Map(), host: 0, phase: 'lobby', timer: null, theme: 'auto', tanks: new Map(), bullets: [], mines: [], pk: [], pid: 1, pkt: 0,
    g: null, free: [], cd: 0, t: 0, n: 0, ev: [], tl: [], z: [0, 0, W, H], ending: 0, winner: null, deathOrder: [], kills: {}, info: new Map(), startMsg: null, overMsg: null };
  rooms.set(code, r); return r;
}
function lobby(r) {
  broadcast(r, { t: 'lobby', ph: r.phase, host: r.host, th: r.theme, pl: [...r.players.values()].map(p => ({ id: p.id, n: p.name, c: p.slot, ab: p.ab })) });
}

function startGame(r) {
  const { g, free } = genMap(), list = [...r.players.values()], sp = pickSpawns(free, list.length);
  r.g = g; r.free = free; r.bullets = []; r.mines = []; r.pk = []; r.pkt = 4; r.t = 0; r.n = 0; r.ev = []; r.tl = []; r.z = [0, 0, W, H];
  r.tanks.clear(); r.info.clear(); r.deathOrder = []; r.kills = {}; r.ending = 0; r.winner = null; r.cd = 3; r.phase = 'playing';
  const th = r.theme === 'auto' ? THEMES[rnd(THEMES.length)] : r.theme, pinfo = [];
  list.forEach((p, i) => {
    const st = rollStats(p.ab), c = sp[i], x = (c % COLS) * CELL + CELL / 2, y = ((c / COLS) | 0) * CELL + CELL / 2;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { // чистим клетки вокруг старта
      const q = c + dy * COLS + dx; if (q >= 0 && q < N && Math.abs((q % COLS) - (c % COLS)) <= 1 && (g[q] === 2 || g[q] === 5)) g[q] = 0;
    }
    r.tanks.set(p.id, { id: p.id, x, y, vx: 0, vy: 0, aim: Math.atan2(H / 2 - y, W / 2 - x), hp: st.hp, max: st.hp, st, cd: 0, alive: true,
      dash: 0, ddx: 0, ddy: 0, shield: 0, haste: 0, rage: 0, acd: 0 });
    r.kills[p.id] = 0; r.info.set(p.id, { id: p.id, n: p.name, c: p.slot, ab: p.ab });
    p.in = 0; p.a = undefined;
    pinfo.push({ id: p.id, n: p.name, c: p.slot, ab: p.ab, hp: st.hp });
  });
  r.startMsg = { t: 'start', grid: Array.from(g).join(''), pl: pinfo, theme: th };
  broadcast(r, r.startMsg); lobby(r);
  clearInterval(r.timer); r.timer = setInterval(() => tick(r), DT * 1000);
}

function finish(r) {
  clearInterval(r.timer); r.timer = null;
  const order = []; if (r.winner) order.push(r.winner);
  for (let i = r.deathOrder.length - 1; i >= 0; i--) order.push(r.deathOrder[i]);
  r.overMsg = { t: 'over', winner: r.winner, rank: order.map(id => ({ ...r.info.get(id), k: r.kills[id] || 0 })) };
  r.phase = 'results'; broadcast(r, r.overMsg); lobby(r);
}

function die(r, t, killer) {
  t.alive = false; r.deathOrder.push(t.id);
  if (killer && killer !== t.id && r.kills[killer] !== undefined) r.kills[killer]++;
  r.ev.push([2, r0(t.x), r0(t.y)]);
  broadcast(r, { t: 'feed', k: killer, v: t.id });
}
function hurt(r, t, d, killer, bypass) {
  if (!t.alive || (t.shield > 0 && !bypass)) return;
  t.hp -= d * t.st.armor; if (t.hp <= 0) die(r, t, killer);
}
function boom(r, x, y, rad, dmg, owner, type) {
  r.ev.push([type, r0(x), r0(y)]);
  for (const t of r.tanks.values()) {
    if (!t.alive) continue;
    const d = Math.hypot(t.x - x, t.y - y);
    if (d < rad + R) hurt(r, t, dmg * (1 - 0.5 * d / (rad + R)), owner);
  }
  const g = r.g, x0 = Math.max(0, ((x - rad) / CELL) | 0), x1 = Math.min(COLS - 1, ((x + rad) / CELL) | 0);
  const y0 = Math.max(0, ((y - rad) / CELL) | 0), y1 = Math.min(ROWS - 1, ((y + rad) / CELL) | 0);
  for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) {
    const i = cy * COLS + cx, v = g[i];
    if (v !== 2 && v !== 5) continue;
    const bx = cx * CELL + 20, by = cy * CELL + 20;
    if (Math.hypot(bx - x, by - y) > rad + 10) continue;
    g[i] = 0; r.tl.push([i, 0]);
    if (v === 5) boom(r, bx, by, 75, 40, owner, 5); else r.ev.push([4, bx, by]);
  }
}
function tileHit(r, v, x, y, owner) { // снаряд попал в ящик/бочку
  const i = ((y / CELL) | 0) * COLS + ((x / CELL) | 0), bx = (i % COLS) * CELL + 20, by = ((i / COLS) | 0) * CELL + 20;
  r.g[i] = 0; r.tl.push([i, 0]);
  if (v === 5) boom(r, bx, by, 75, 40, owner, 5); else r.ev.push([4, bx, by]);
}

function tick(r) {
  const g = r.g, tanks = r.tanks, bullets = r.bullets, ev = r.ev, alive = [];
  r.n++;
  for (const t of tanks.values()) if (t.alive) alive.push(t);

  if (r.cd > 0) r.cd -= DT;
  else {
    r.t += DT;
    for (const t of alive) {
      const p = r.players.get(t.id), k = p ? p.in : 0, st = t.st;
      if (p && p.a !== undefined) { // башня быстро следует за мышью
        const d = Math.atan2(Math.sin(p.a - t.aim), Math.cos(p.a - t.aim)), m = st.turn * 5 * DT;
        t.aim += Math.max(-m, Math.min(m, d));
      }
      let dx = ((k & 8) ? 1 : 0) - ((k & 4) ? 1 : 0), dy = ((k & 2) ? 1 : 0) - ((k & 1) ? 1 : 0);
      const l = Math.hypot(dx, dy); if (l) { dx /= l; dy /= l; }
      t.acd = Math.max(0, t.acd - DT); t.cd -= DT; t.shield -= DT; t.haste -= DT; t.rage -= DT;
      if ((k & 128) && st.act && t.acd <= 0) {
        t.acd = st.acd;
        if (st.ab === 'dash') { t.dash = 0.17; t.ddx = l ? dx : Math.cos(t.aim); t.ddy = l ? dy : Math.sin(t.aim); ev.push([7, r0(t.x), r0(t.y)]); }
        else if (st.ab === 'shield') { t.shield = 2.2; ev.push([9, r0(t.x), r0(t.y)]); }
        else { r.mines.push({ x: t.x, y: t.y, o: t.id, arm: 1, life: 40 }); ev.push([10, r0(t.x), r0(t.y)]); }
      }
      if (t.dash > 0) { t.dash -= DT; t.vx = t.ddx * 780; t.vy = t.ddy * 780; }
      else { const sp = st.speed * (t.haste > 0 ? 1.4 : 1), a = Math.min(1, DT * 14); t.vx += (dx * sp - t.vx) * a; t.vy += (dy * sp - t.vy) * a; }
      const mx = t.vx * DT, my = t.vy * DT;
      if (!blocked(g, t.x + mx, t.y)) t.x += mx; else t.vx = 0;
      if (!blocked(g, t.x, t.y + my)) t.y += my; else t.vy = 0;
      if (st.regen && t.hp < t.max) t.hp = Math.min(t.max, t.hp + st.regen * DT);
      if ((k & 64) && t.cd <= 0) {
        t.cd = st.reload;
        for (const s of st.shots === 3 ? [-0.2, 0, 0.2] : [0]) {
          const a = t.aim + s;
          bullets.push({ x: t.x + Math.cos(a) * R, y: t.y + Math.sin(a) * R, vx: Math.cos(a) * st.bspeed, vy: Math.sin(a) * st.bspeed,
            o: t.id, d: st.dmg * (t.rage > 0 ? 1.6 : 1), b: st.bounces, pr: st.pierce, lh: 0, age: 0, life: st.bounces ? 3 : 2 });
        }
        ev.push([0, r0(t.x), r0(t.y)]);
      }
    }
    for (let i = 0; i < alive.length; i++) for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i], b = alive[j], dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy);
      if (d > 0 && d < R * 2) {
        const push = (R * 2 - d) / 2, nx = dx / d * push, ny = dy / d * push;
        if (!blocked(g, a.x - nx, a.y - ny)) { a.x -= nx; a.y -= ny; }
        if (!blocked(g, b.x + nx, b.y + ny)) { b.x += nx; b.y += ny; }
      }
    }
    // шторм: безопасная зона сужается после 25 секунд
    const f = Math.max(0, Math.min(1, (r.t - 25) / 80)), s = 1 - f * 0.78, zx = W * (1 - s) / 2, zy = H * (1 - s) / 2;
    r.z = [r0(zx), r0(zy), r0(W - zx), r0(H - zy)];
    for (const t of alive) if (t.alive && (t.x < zx || t.x > W - zx || t.y < zy || t.y > H - zy)) hurt(r, t, 7 * DT, 0, true);
    // бонусы
    r.pkt -= DT;
    if (r.pkt <= 0 && r.pk.length < 5) {
      r.pkt = 5 + Math.random() * 4;
      const c = r.free[rnd(r.free.length)];
      if (g[c] === 0 || g[c] === 4) r.pk.push({ x: (c % COLS) * CELL + 20, y: ((c / COLS) | 0) * CELL + 20, ty: rnd(3) });
    }
    for (let i = r.pk.length - 1; i >= 0; i--) {
      const q = r.pk[i];
      for (const t of alive) {
        if (!t.alive || (t.x - q.x) ** 2 + (t.y - q.y) ** 2 > (R + 12) ** 2) continue;
        if (q.ty === 0) t.hp = Math.min(t.max, t.hp + t.max * 0.4); else if (q.ty === 1) t.haste = 8; else t.rage = 8;
        ev.push([6, q.x, q.y, q.ty]); r.pk.splice(i, 1); break;
      }
    }
    // мины
    for (let i = r.mines.length - 1; i >= 0; i--) {
      const m = r.mines[i]; m.arm -= DT; m.life -= DT;
      let go = m.life <= 0;
      if (m.arm <= 0) for (const t of alive) if (t.alive && t.id !== m.o && (t.x - m.x) ** 2 + (t.y - m.y) ** 2 < (R + 10) ** 2) { go = true; break; }
      if (go) { r.mines.splice(i, 1); if (m.life > 0) boom(r, m.x, m.y, 70, 45, m.o, 8); }
    }
  }

  for (let i = bullets.length - 1; i >= 0; i--) {
    const b = bullets[i]; b.age += DT;
    let rm = b.age > b.life;
    if (!rm) {
      const nx = b.x + b.vx * DT, ny = b.y + b.vy * DT, v = hit(g, nx, ny);
      if (v === 2 || v === 5) { tileHit(r, v, nx, ny, b.o); rm = true; }
      else if (v === 1) {
        ev.push([3, r0(nx), r0(ny)]);
        if (b.b > 0) {
          b.b--;
          const wx = hit(g, nx, b.y), wy = hit(g, b.x, ny);
          if (wx && !wy) b.vx = -b.vx; else if (wy && !wx) b.vy = -b.vy; else { b.vx = -b.vx; b.vy = -b.vy; }
        } else rm = true;
      } else { b.x = nx; b.y = ny; }
    }
    if (!rm) for (const t of alive) {
      if (!t.alive || t.id === b.lh || (t.id === b.o && b.age < 0.25)) continue;
      if ((t.x - b.x) ** 2 + (t.y - b.y) ** 2 < (R + BR) ** 2) {
        if (t.shield > 0) { ev.push([9, r0(b.x), r0(b.y)]); rm = true; break; }
        const o = tanks.get(b.o);
        hurt(r, t, b.d, b.o);
        if (o && o.alive && o.st.vamp) o.hp = Math.min(o.max, o.hp + b.d * t.st.armor * o.st.vamp);
        ev.push([1, r0(b.x), r0(b.y)]);
        if (b.pr > 0) { b.pr--; b.lh = t.id; } else rm = true;
        break;
      }
    }
    if (rm) { bullets[i] = bullets[bullets.length - 1]; bullets.pop(); }
  }

  if (!r.ending) {
    const left = []; for (const t of tanks.values()) if (t.alive) left.push(t);
    if ((tanks.size > 1 && left.length <= 1) || left.length === 0) { r.ending = 1.5; r.winner = left.length ? left[0].id : null; }
  } else { r.ending -= DT; if (r.ending <= 0) return finish(r); }

  if (r.n & 1) return; // снимки состояния 30 раз в секунду, симуляция 60
  const p = [];
  for (const t of tanks.values()) if (t.alive)
    p.push([t.id, r1(t.x), r1(t.y), Math.round(t.aim * 100) / 100, Math.max(1, Math.round(t.hp)),
      (t.shield > 0 ? 1 : 0) | (t.haste > 0 ? 2 : 0) | (t.rage > 0 ? 4 : 0) | (t.dash > 0 ? 8 : 0), t.st.acd ? Math.round(t.acd / t.st.acd * 100) / 100 : 0]);
  const m = { t: 's', cd: r.cd > 0 ? r1(r.cd) : 0, p, z: r.z,
    b: bullets.map(x => [r0(x.x), r0(x.y), x.o, r0(x.vx), r0(x.vy)]),
    pk: r.pk.map(q => [q.x, q.y, q.ty]), mn: r.mines.map(q => [r0(q.x), r0(q.y), q.arm <= 0 ? 1 : 0]) };
  if (ev.length) m.e = ev;
  if (r.tl.length) m.tl = r.tl;
  r.ev = []; r.tl = [];
  broadcast(r, m);
}

function leave(r, p) {
  r.players.delete(p.id);
  if (!r.players.size) { clearInterval(r.timer); rooms.delete(r.code); return; }
  if (r.host === p.id) r.host = r.players.keys().next().value;
  const t = r.tanks.get(p.id);
  if (r.phase === 'playing' && t && t.alive) { t.alive = false; r.deathOrder.push(t.id); broadcast(r, { t: 'feed', k: null, v: t.id }); }
  lobby(r);
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', ws => {
  ws.isAlive = true; ws.on('pong', () => { ws.isAlive = true; });
  let p = null, room = null;
  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (!p) {
      if (m.t !== 'join') return;
      const name = String(m.name || '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 12) || 'Игрок';
      let r;
      if (m.room) { r = rooms.get(String(m.room).toUpperCase().slice(0, 4)); if (!r) return send(ws, { t: 'err', m: 'Комната не найдена' }); }
      else r = newRoom();
      if (r.players.size >= MAXP) return send(ws, { t: 'err', m: 'Комната заполнена (макс. 10)' });
      const used = new Set([...r.players.values()].map(x => x.slot));
      let slot = 0; while (used.has(slot)) slot++;
      p = { id: nextId++, name, ws, slot, in: 0, a: undefined, ab: ABKEYS[rnd(ABKEYS.length)] };
      room = r; r.players.set(p.id, p);
      if (!r.host) r.host = p.id;
      send(ws, { t: 'joined', id: p.id, room: r.code });
      lobby(r);
      if (r.phase === 'playing' && r.startMsg) send(ws, r.startMsg);
      else if (r.phase === 'results' && r.overMsg) send(ws, r.overMsg);
      return;
    }
    switch (m.t) {
      case 'in': p.in = (m.k | 0) & 255; if (Number.isFinite(m.a)) p.a = m.a; break;
      case 'pick': if (room.phase !== 'playing' && ABKEYS.includes(m.ab)) { p.ab = m.ab; lobby(room); } break;
      case 'cfg': if (room.host === p.id && room.phase !== 'playing' && (m.th === 'auto' || THEMES.includes(m.th))) { room.theme = m.th; lobby(room); } break;
      case 'start': if (room.host === p.id && room.phase !== 'playing') startGame(room); break;
      case 'again': if (room.host === p.id && room.phase === 'results') { room.phase = 'lobby'; lobby(room); } break;
    }
  });
  ws.on('close', () => { if (p) leave(room, p); });
  ws.on('error', () => {});
});
setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 25000);
server.listen(PORT, () => console.log('Танчики: http://localhost:' + PORT));
