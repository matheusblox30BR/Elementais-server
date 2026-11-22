'use strict';
/**
 * Elementais 3D — servidor multiplayer
 *
 *  - Serve o jogo (pasta /public) e o WebSocket no MESMO endereço/porta.
 *  - Existe UM servidor público: todo mundo que entra cai na mesma sala.
 *  - O servidor é quem manda em: relógio dia/noite, zumbis (spawn, vida, perseguição)
 *    e na lista de jogadores. Zumbis só aparecem de noite e seguem o jogador mais próximo.
 *  - Sem PvP: jogadores nunca causam dano uns aos outros.
 *  - Abate compartilhado: todo jogador que acertou o zumbi recebe a recompensa.
 *  - Antilag: os clientes mandam estado a cada 0,1 s; o servidor devolve um snapshot
 *    a cada 0,1 s; o cliente interpola (veja INTERP no index.html).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ---------- configuração ----------
const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, 'public');
const MAX_PLAYERS = 30;
const DAY_T = 60, NIGHT_T = 90, CYC = DAY_T + NIGHT_T;   // dia 1:00 · noite 1:30
const LIMIT = 150;            // limite do mapa (jogadores)
const SPAWN_LIMIT = 116;      // limite onde zumbis nascem
const SEND_DT = 0.1;          // snapshot a cada 0,1 s (10 Hz)
const ELS = ['fire', 'water', 'wind', 'earth'];
const CLASSES = ['war', 'arc', 'mage'];
const ACTS = new Set(['bolt', 'arrow', 'slash', 'wave', 'dash', 'spike']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// ---------- HTTP (arquivos estáticos) ----------
const server = http.createServer((req, res) => {
  const url = (req.url || '/').split('?')[0];
  if (url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('ok');
  }
  let file;
  try {
    file = path.normalize(path.join(PUBLIC, decodeURIComponent(url === '/' ? '/index.html' : url)));
  } catch (e) {
    res.writeHead(400);
    return res.end();
  }
  if (!file.startsWith(PUBLIC + path.sep)) {
    res.writeHead(403);
    return res.end();
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
});

// ---------- estado do jogo ----------
const players = new Map();   // id -> jogador
const zmap = new Map();      // id -> zumbi
let nextId = 1, nextZ = 1;
let clock = Number(process.env.CLOCK_START) || 0;   // segundos dentro do ciclo (0 = 06:00)
let day = 1;
let wasNight = clock >= DAY_T;
let spawnT = 2;
let sendAcc = 0;

const r2 = (v) => Math.round(v * 100) / 100;
const num = (v, d = 0) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function cleanName(s) {
  return String(s || '').replace(/[^\p{L}\p{N} _\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 14);
}
function uniqueName(base) {
  const used = new Set([...players.values()].map((p) => p.name.toLowerCase()));
  if (!used.has(base.toLowerCase())) return base;
  for (let i = 2; i < 100; i++) {
    const n = base.slice(0, 11) + ' ' + i;
    if (!used.has(n.toLowerCase())) return n;
  }
  return base + Math.floor(Math.random() * 1000);
}
function cleanAp(ap) {
  const id = (v, re, d) => (typeof v === 'string' && re.test(v) ? v : d);
  ap = ap || {};
  return { sh: id(ap.sh, /^s\d{1,2}$/, 's0'), pn: id(ap.pn, /^p\d{1,2}$/, 'p0'), ht: id(ap.ht, /^h\d{1,2}$/, 'h0') };
}
const pub = (p) => ({ id: p.id, name: p.name, cls: p.cls, el: p.el, ap: p.ap, a: p.a });

function send(ws, o) {
  if (ws.readyState === 1) ws.send(JSON.stringify(o));
}
function bc(o, except) {
  const s = JSON.stringify(o);
  for (const p of players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
}
// limite de mensagens por jogador (anti-flood)
function allow(p) {
  const now = Date.now();
  p.tok = Math.min(120, p.tok + ((now - p.tt) / 1000) * 90);
  p.tt = now;
  if (p.tok < 1) return false;
  p.tok -= 1;
  return true;
}

// ---------- jogadores ----------
function join(ws, m) {
  if (players.size >= MAX_PLAYERS) {
    send(ws, { t: 'x', m: 'Servidor cheio (' + MAX_PLAYERS + ' jogadores). Tente de novo em instantes.' });
    ws.close();
    return;
  }
  const id = nextId++;
  const now = Date.now();
  const p = {
    id, ws, name: uniqueName(cleanName(m.name) || 'Jogador'),
    x: 0, z: 0, f: 0, a: 0, w: 0, cls: '', el: '', ap: cleanAp(m.ap),
    inv: 0, ts: now, tok: 120, tt: now,
  };
  ws.player = p;
  players.set(id, p);
  send(ws, { t: 'w', id, name: p.name, c: r2(clock), d: day, ps: [...players.values()].filter((q) => q !== p).map(pub) });
  bc({ t: 'pj', p: pub(p) }, p);
  console.log('+ entrou:', p.name, '(' + players.size + ' online)');
}
function leave(p) {
  if (!p || !players.has(p.id)) return;
  players.delete(p.id);
  bc({ t: 'pl', id: p.id });
  if (!players.size) zmap.clear();
  console.log('- saiu:', p.name, '(' + players.size + ' online)');
}

function handle(p, m) {
  const now = Date.now();
  switch (m.t) {
    case 's': {   // estado do jogador (posição) — 10x por segundo
      const x = m.x, z = m.z;
      if (typeof x !== 'number' || typeof z !== 'number' || !isFinite(x) || !isFinite(z)) break;
      const dt = Math.max(0.02, (now - p.ts) / 1000);
      p.ts = now;
      let nx = clamp(x, -LIMIT, LIMIT), nz = clamp(z, -LIMIT, LIMIT);
      // antiteleporte: limita o quanto a posição pode andar entre dois pacotes
      const maxd = 10 + 45 * dt, d = Math.hypot(nx - p.x, nz - p.z);
      if (d > maxd) { const k = maxd / d; nx = p.x + (nx - p.x) * k; nz = p.z + (nz - p.z) * k; }
      p.x = nx; p.z = nz;
      p.f = num(m.f);
      p.a = m.a ? 1 : 0;
      p.w = m.w ? 1 : 0;
      break;
    }
    case 'spawn': {   // entrou na partida (escolheu classe)
      p.cls = CLASSES.includes(m.cls) ? m.cls : 'mage';
      p.el = p.cls === 'mage' && ELS.includes(m.el) ? m.el : '';
      p.ap = cleanAp(m.ap);
      p.x = 0; p.z = 0; p.a = 1; p.inv = 2; p.ts = now;
      const o = pub(p); o.sp = 1;
      bc({ t: 'pc', p: o }, p);
      break;
    }
    case 'cl': {      // trocou de elemento
      p.el = ELS.includes(m.el) ? m.el : p.el;
      bc({ t: 'pc', p: pub(p) }, p);
      break;
    }
    case 'ap': {      // trocou de roupa
      p.ap = cleanAp(m.ap);
      bc({ t: 'pc', p: pub(p) }, p);
      break;
    }
    case 'act': {     // ataque/habilidade: só repassa para os outros desenharem
      if (!p.a || !ACTS.has(m.k)) break;
      bc({
        t: 'act', id: p.id, k: m.k,
        x: r2(num(m.x)), z: r2(num(m.z)), a: r2(num(m.a)),
        el: ELS.includes(m.el) ? m.el : 'fire',
        s: r2(clamp(num(m.s, 38), 0, 120)), l: r2(clamp(num(m.l, 1.3), 0, 3)),
      }, p);
      break;
    }
    case 'hit': {     // o cliente acertou um zumbi (o servidor desconta a vida)
      if (!p.a) break;
      const z = zmap.get(m.id);
      const d = num(m.d);
      if (!z || d <= 0) break;
      if (Math.hypot(z.x - p.x, z.z - p.z) > 100) break;   // longe demais: ignora
      z.hp -= Math.min(d, 12);
      z.by.add(p.id);                                      // quem bateu ganha a recompensa
      if (z.hp <= 0) killZ(z);
      break;
    }
    case 'ping':
      send(p.ws, { t: 'pong', ts: num(m.ts) });
      break;
  }
}

// ---------- zumbis ----------
function spawnZ(alive) {
  const t = alive[Math.floor(Math.random() * alive.length)];
  const a = Math.random() * Math.PI * 2, r = 20 + Math.random() * 6;
  const z = {
    id: nextZ++,
    x: clamp(t.x + Math.cos(a) * r, -SPAWN_LIMIT, SPAWN_LIMIT),
    z: clamp(t.z + Math.sin(a) * r, -SPAWN_LIMIT, SPAWN_LIMIT),
    hp: 2,
    sp: 1.8 + Math.random() * 0.8 + Math.min((day - 1) * 0.08, 0.6),   // zumbis fracos; ficam um pouco mais rápidos a cada dia
    by: new Set(),
  };
  zmap.set(z.id, z);
}
function killZ(z) {
  zmap.delete(z.id);
  bc({ t: 'zk', id: z.id, x: r2(z.x), z: r2(z.z), by: [...z.by] });
}

function step(dt) {
  const list = [...players.values()];
  if (!list.length) { zmap.clear(); return; }
  const alive = list.filter((p) => p.a);

  // relógio (só anda com gente online)
  clock += dt;
  if (clock >= CYC) { clock -= CYC; day++; }
  const night = clock >= DAY_T;
  if (night !== wasNight) {
    wasNight = night;
    if (night) spawnT = 1; else zmap.clear();   // amanheceu: zumbis somem
  }
  for (const p of list) if (p.inv > 0) p.inv -= dt;

  // nascimento (só de noite)
  if (night && alive.length) {
    spawnT -= dt;
    const cap = Math.min(40, 8 + 5 * alive.length);
    if (spawnT <= 0 && zmap.size < cap) {
      spawnT = Math.max(0.4, 1.6 / (1 + 0.4 * (alive.length - 1)));
      spawnZ(alive);
    }
  }

  // movimento: cada zumbi segue o jogador VIVO mais próximo
  const zs = [...zmap.values()];
  for (const z of zs) {
    let best = null, bd = Infinity;
    for (const p of alive) {
      const d2 = (p.x - z.x) ** 2 + (p.z - z.z) ** 2;
      if (d2 < bd) { bd = d2; best = p; }
    }
    if (!best) continue;
    const d = Math.sqrt(bd);
    if (d > 0.8) {
      z.x += ((best.x - z.x) / d) * z.sp * dt;
      z.z += ((best.z - z.z) / d) * z.sp * dt;
    }
    if (d < 1.3 && best.inv <= 0) {          // mordida: meio coração, 1 s de invencibilidade
      best.inv = 1;
      send(best.ws, { t: 'hu', d: 0.5 });
    }
  }
  // zumbis não ficam empilhados
  for (let i = 0; i < zs.length; i++) {
    for (let j = i + 1; j < zs.length; j++) {
      const a = zs[i], b = zs[j];
      let dx = b.x - a.x, dz = b.z - a.z;
      const d2 = dx * dx + dz * dz;
      if (d2 < 0.64 && d2 > 1e-6) {
        const d = Math.sqrt(d2), push = (0.8 - d) / 2;
        dx /= d; dz /= d;
        a.x -= dx * push; a.z -= dz * push;
        b.x += dx * push; b.z += dz * push;
      }
    }
  }
}

function snapshot() {
  const ps = [], zs = [];
  for (const p of players.values()) ps.push([p.id, r2(p.x), r2(p.z), r2(p.f), p.a, p.w]);
  for (const z of zmap.values()) zs.push([z.id, r2(z.x), r2(z.z), Math.round(z.hp * 10) / 10]);
  const s = JSON.stringify({ t: 'n', ts: Date.now() / 1000, c: r2(clock), d: day, p: ps, z: zs });
  for (const p of players.values()) {
    if (p.ws.readyState === 1 && p.ws.bufferedAmount < 1e6) p.ws.send(s);
  }
}

// ---------- WebSocket ----------
const wss = new WebSocketServer({ server, maxPayload: 2048 });
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  const joinTimer = setTimeout(() => { if (!ws.player) ws.close(); }, 10000);
  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;
    if (!ws.player) { if (m.t === 'join') join(ws, m); return; }
    if (!allow(ws.player)) return;
    handle(ws.player, m);
  });
  ws.on('close', () => { clearTimeout(joinTimer); leave(ws.player); });
  ws.on('error', () => {});
});

// derruba conexões mortas
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch (e) { /* ignore */ }
  }
}, 30000);

// laço principal: simula a 20 Hz e manda snapshot a cada 0,1 s
let lastT = Date.now();
setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.2, (now - lastT) / 1000);
  lastT = now;
  step(dt);
  sendAcc += dt;
  if (sendAcc >= SEND_DT) { sendAcc -= SEND_DT; if (sendAcc > SEND_DT) sendAcc = 0; snapshot(); }
}, 50);

server.listen(PORT, '0.0.0.0', () => console.log('Elementais 3D rodando na porta ' + PORT));
process.on('SIGTERM', () => { wss.close(); server.close(() => process.exit(0)); });
