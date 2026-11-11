'use strict';
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const { Server } = require('socket.io');

const scrypt = promisify(crypto.scrypt);
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

/* ---------- tiny file-backed storage ---------- */
fs.mkdirSync(DATA_DIR, { recursive: true });
function load(file) {
  const out = Object.create(null);
  try { Object.assign(out, JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'))); } catch {}
  return out;
}
function save(file, obj) {
  const p = path.join(DATA_DIR, file);
  fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
  fs.renameSync(p + '.tmp', p);
}
const users = load('users.json');       // lowercased name -> { name, salt, hash, created }
const sessions = load('sessions.json'); // sha256(token) -> { user, exp }

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function userFromCookie(header) {
  const token = parseCookies(header).sid;
  if (!token) return null;
  const key = sha(token);
  const s = sessions[key];
  if (!s) return null;
  if (s.exp < Date.now() || !users[s.user]) { delete sessions[key]; return null; }
  return users[s.user].name;
}

/* ---------- HTTP: accounts ---------- */
const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '10kb' }));

const attempts = new Map();
function limited(req) {
  const now = Date.now();
  const a = attempts.get(req.ip);
  if (!a || a.reset < now) { attempts.set(req.ip, { n: 1, reset: now + 10 * 60 * 1000 }); return false; }
  return ++a.n > 30;
}
function startSession(req, res, key) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions[sha(token)] = { user: key, exp: Date.now() + SESSION_MS };
  save('sessions.json', sessions);
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: SESSION_MS });
}
function creds(req) {
  const username = String((req.body && req.body.username) || '').trim();
  const password = String((req.body && req.body.password) || '');
  return { username, password, key: username.toLowerCase() };
}

app.post('/api/register', async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password, key } = creds(req);
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–20 letters, numbers or _' });
  if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  if (users[key]) return res.status(409).json({ error: 'That username is taken' });
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  if (users[key]) return res.status(409).json({ error: 'That username is taken' });
  users[key] = { name: username, salt, hash, created: Date.now() };
  save('users.json', users);
  startSession(req, res, key);
  res.json({ name: username });
});

app.post('/api/login', async (req, res) => {
  if (limited(req)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { password, key } = creds(req);
  const u = users[key];
  const hash = await scrypt(password, u ? u.salt : 'no-such-user', 64);
  if (!u || !crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'))) {
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  startSession(req, res, key);
  res.json({ name: u.name });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) { delete sessions[sha(token)]; save('sessions.json', sessions); }
  res.clearCookie('sid');
  res.json({ ok: true });
});

app.get('/api/me', (req, res) => {
  const name = userFromCookie(req.headers.cookie);
  if (!name) return res.status(401).json({ error: 'Not logged in' });
  res.json({ name });
});

app.use(express.static(path.join(__dirname, 'public')));

/* ---------- realtime: rooms ---------- */
const server = http.createServer(app);
const io = new Server(server);

io.use((socket, next) => {
  const name = userFromCookie(socket.request.headers.cookie);
  if (!name) return next(new Error('unauthorized'));
  socket.data.user = name;
  next();
});

const rooms = new Map();
const MEDIA = new Set(['video', 'youtube', 'file']);

function getRoom(code) {
  let r = rooms.get(code);
  if (!r) {
    r = { code, members: new Map(), chat: [], stage: { kind: 'none' }, game: null, gc: null };
    rooms.set(code, r);
  }
  return r;
}
const roomOf = (socket) => rooms.get(socket.data.room);
const membersOf = (r) => [...r.members].map(([id, m]) => ({ id, name: m.name }));

function pushChat(r, msg) {
  msg.ts = Date.now();
  r.chat.push(msg);
  if (r.chat.length > 150) r.chat.shift();
  io.to(r.code).emit('chat', msg);
}
const sys = (r, text) => pushChat(r, { sys: true, text });

function stagePublic(r) {
  const s = r.stage;
  if (!MEDIA.has(s.kind)) return s;
  const time = s.playing ? s.time + (Date.now() - s.at) / 1000 : s.time;
  return { kind: s.kind, src: s.src, by: s.by, playing: s.playing, time };
}
function setStage(r, stage) {
  if (r.game) clearTimeout(r.game.timer);
  r.game = null;
  r.stage = stage;
  io.to(r.code).emit('stage', stagePublic(r));
}

/* ---------- games ---------- */
const GAME_NAMES = { ttt: 'Tic-Tac-Toe', four: 'Four in a Row', draw: 'Draw & Guess' };
const TTT_LINES = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
const ROUND_MS = 80000;
const WORDS = ['popcorn', 'pirate', 'rocket', 'dragon', 'guitar', 'castle', 'rainbow', 'robot', 'pizza', 'elephant',
  'volcano', 'spider', 'bicycle', 'ghost', 'camera', 'island', 'tornado', 'penguin', 'wizard', 'mermaid',
  'snowman', 'cactus', 'dinosaur', 'umbrella', 'lighthouse', 'astronaut', 'vampire', 'treasure', 'ninja', 'zombie',
  'helicopter', 'butterfly', 'waterfall', 'crown', 'skateboard', 'octopus', 'campfire', 'telescope', 'sandwich', 'superhero',
  'train', 'moon', 'ladder', 'bridge', 'anchor', 'candle', 'giraffe', 'kite', 'pyramid', 'sword',
  'cowboy', 'alien', 'balloon', 'hammer', 'ice cream', 'roller coaster', 'haunted house', 'time machine', 'movie ticket', 'red carpet'];

function newGame(type) {
  if (type === 'ttt') return { type, players: [], board: Array(9).fill(null), turn: 0, starts: 0, winner: null, line: null };
  if (type === 'four') return { type, players: [], board: Array(42).fill(null), turn: 0, starts: 0, winner: null, line: null };
  return { type, phase: 'waiting', round: 0, drawer: null, drawerName: '', word: null, guessed: [], strokes: [],
    scores: Object.create(null), endsAt: 0, timer: null };
}
function resetBoard(g, flip) {
  g.board.fill(null);
  if (flip) g.starts ^= 1;
  g.turn = g.starts;
  g.winner = null;
  g.line = null;
}
function gamePublic(r, full) {
  const g = r.game;
  if (!g) return null;
  if (g.type !== 'draw') {
    return { type: g.type, players: g.players, board: g.board, turn: g.turn, winner: g.winner, line: g.line };
  }
  const out = {
    type: 'draw', phase: g.phase, round: g.round, drawer: g.drawer, drawerName: g.drawerName,
    hint: g.word ? g.word.replace(/[a-z]/g, '_') : '', word: g.phase === 'reveal' ? g.word : null,
    remaining: Math.max(0, g.endsAt - Date.now()), scores: g.scores, guessed: g.guessed,
  };
  if (full) out.strokes = g.strokes;
  return out;
}
const emitGame = (r) => io.to(r.code).emit('game', gamePublic(r));

function fourWin(b) {
  for (let r = 0; r < 6; r++) for (let c = 0; c < 7; c++) {
    const v = b[r * 7 + c];
    if (v === null) continue;
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const cells = [];
      for (let k = 0; k < 4; k++) {
        const rr = r + dr * k, cc = c + dc * k;
        if (rr < 0 || rr > 5 || cc < 0 || cc > 6 || b[rr * 7 + cc] !== v) break;
        cells.push(rr * 7 + cc);
      }
      if (cells.length === 4) return cells;
    }
  }
  return null;
}
function boardMove(g, seat, m) {
  if (g.type === 'ttt') {
    if (!Number.isInteger(m) || m < 0 || m > 8 || g.board[m] !== null) return false;
    g.board[m] = seat;
    g.line = TTT_LINES.find((l) => l.every((i) => g.board[i] === seat)) || null;
  } else {
    if (!Number.isInteger(m) || m < 0 || m > 6) return false;
    let row = 5;
    while (row >= 0 && g.board[row * 7 + m] !== null) row--;
    if (row < 0) return false;
    g.board[row * 7 + m] = seat;
    g.line = fourWin(g.board);
  }
  if (g.line) g.winner = seat;
  else if (g.board.every((v) => v !== null)) g.winner = 'draw';
  else g.turn ^= 1;
  return true;
}

function startRound(r) {
  const g = r.game;
  if (!g || g.type !== 'draw') return;
  clearTimeout(g.timer);
  const ids = [...r.members.keys()];
  if (!ids.length) return;
  g.drawer = ids[(ids.indexOf(g.drawer) + 1) % ids.length];
  g.drawerName = r.members.get(g.drawer).name;
  let word;
  do { word = WORDS[crypto.randomInt(WORDS.length)]; } while (word === g.word);
  g.word = word;
  g.guessed = [];
  g.strokes = [];
  g.phase = 'drawing';
  g.round++;
  g.endsAt = Date.now() + ROUND_MS;
  g.timer = setTimeout(() => endRound(r, g), ROUND_MS);
  emitGame(r);
  io.to(g.drawer).emit('draw:word', g.word);
}
function endRound(r, g) {
  if (r.game !== g || g.phase !== 'drawing') return;
  clearTimeout(g.timer);
  g.phase = 'reveal';
  g.endsAt = Date.now() + 5000;
  emitGame(r);
  g.timer = setTimeout(() => { if (r.game === g) startRound(r); }, 5000);
}
const normWord = (s) => s.toLowerCase().replace(/[^a-z]/g, '');

// Returns true if the chat line was consumed as a guess.
function handleGuess(r, socket, text) {
  const g = r.game;
  if (!g || g.type !== 'draw' || g.phase !== 'drawing') return false;
  const name = socket.data.user;
  const guess = normWord(text), word = normWord(g.word);
  if (socket.id === g.drawer) {
    if (guess.includes(word)) {
      socket.emit('chat', { sys: true, text: "No spoilers — you can't type the word while drawing!", ts: Date.now() });
      return true;
    }
    return false;
  }
  if (guess !== word) return false;
  if (!g.guessed.includes(name)) {
    g.guessed.push(name);
    const secsLeft = Math.max(0, g.endsAt - Date.now()) / 1000;
    g.scores[name] = (g.scores[name] || 0) + 10 + Math.ceil(secsLeft / 8);
    g.scores[g.drawerName] = (g.scores[g.drawerName] || 0) + 5;
    sys(r, `${name} guessed the word!`);
    const guessers = new Set([...r.members].filter(([id]) => id !== g.drawer).map(([, m]) => m.name));
    if ([...guessers].every((n) => g.guessed.includes(n))) endRound(r, g);
    else emitGame(r);
  }
  return true;
}

/* ---------- socket handlers ---------- */
function leave(socket) {
  const r = roomOf(socket);
  if (!r) return;
  const name = socket.data.user;
  r.members.delete(socket.id);
  socket.leave(r.code);
  socket.data.room = null;
  io.to(r.code).emit('members', membersOf(r));
  sys(r, `${name} left the theater`);

  if (r.stage.kind === 'share' && r.stage.sharer === socket.id) setStage(r, { kind: 'none' });
  const g = r.game;
  if (g && g.type !== 'draw') {
    const i = g.players.findIndex((p) => p.id === socket.id);
    if (i >= 0) { g.players.splice(i, 1); resetBoard(g, false); emitGame(r); }
  } else if (g && g.drawer === socket.id) {
    endRound(r, g);
  }
  if (r.members.size === 0) {
    if (r.stage.kind === 'game') setStage(r, { kind: 'none' });
    r.gc = setTimeout(() => { if (r.members.size === 0) rooms.delete(r.code); }, 5 * 60 * 1000);
  }
}

io.on('connection', (socket) => {
  const name = socket.data.user;

  socket.on('join', (code, ack) => {
    if (typeof ack !== 'function') return;
    code = String(code || '').toUpperCase();
    if (!/^[A-Z0-9]{3,12}$/.test(code)) return ack({ error: 'That theater code is not valid.' });
    if (socket.data.room) leave(socket);
    const r = getRoom(code);
    if (r.members.size >= 20) return ack({ error: 'This theater is full (20 seats).' });
    clearTimeout(r.gc);
    r.members.set(socket.id, { name });
    socket.join(code);
    socket.data.room = code;
    ack({ id: socket.id, members: membersOf(r), chat: r.chat, stage: stagePublic(r), game: gamePublic(r, true) });
    socket.to(code).emit('members', membersOf(r));
    sys(r, `${name} took a seat`);
  });

  socket.on('chat', (text) => {
    const r = roomOf(socket);
    if (!r) return;
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    if (r.stage.kind === 'game' && handleGuess(r, socket, text)) return;
    pushChat(r, { name, text });
  });

  /* stage: what's on the big screen */
  socket.on('stage:set', (d) => {
    const r = roomOf(socket);
    if (!r || !d) return;
    if (d.kind === 'none') { setStage(r, { kind: 'none' }); return sys(r, `${name} cleared the screen`); }
    const src = String(d.src || '');
    const ok = (d.kind === 'youtube' && /^[\w-]{11}$/.test(src))
      || (d.kind === 'video' && /^https?:\/\//i.test(src) && src.length <= 2000)
      || (d.kind === 'file' && src.length > 0 && src.length <= 200);
    if (!ok) return;
    setStage(r, { kind: d.kind, src, by: name, playing: false, time: 0, at: Date.now() });
    sys(r, `${name} put ${d.kind === 'youtube' ? 'a YouTube video' : d.kind === 'file' ? `"${src}"` : 'a video'} on the screen`);
  });
  socket.on('stage:ctl', (d) => {
    const r = roomOf(socket);
    if (!r || !d || !MEDIA.has(r.stage.kind)) return;
    const time = Number(d.time);
    if (!Number.isFinite(time) || time < 0) return;
    Object.assign(r.stage, { playing: !!d.playing, time, at: Date.now() });
    socket.to(r.code).emit('sync', { playing: r.stage.playing, time, by: name });
  });
  socket.on('stage:get', (ack) => {
    const r = roomOf(socket);
    if (r && typeof ack === 'function') ack(stagePublic(r));
  });

  /* screen sharing (WebRTC signalling only — video goes peer to peer) */
  socket.on('share:start', () => {
    const r = roomOf(socket);
    if (!r) return;
    setStage(r, { kind: 'share', sharer: socket.id, name });
    sys(r, `${name} is sharing their screen`);
  });
  socket.on('share:stop', () => {
    const r = roomOf(socket);
    if (r && r.stage.kind === 'share' && r.stage.sharer === socket.id) setStage(r, { kind: 'none' });
  });
  socket.on('share:want', () => {
    const r = roomOf(socket);
    if (r && r.stage.kind === 'share' && r.stage.sharer !== socket.id) {
      io.to(r.stage.sharer).emit('share:want', { from: socket.id });
    }
  });
  socket.on('rtc', (d) => {
    const r = roomOf(socket);
    if (r && d && r.members.has(d.to)) io.to(d.to).emit('rtc', { from: socket.id, data: d.data });
  });

  /* games */
  socket.on('game:start', (type) => {
    const r = roomOf(socket);
    if (!r || !GAME_NAMES[type]) return;
    setStage(r, { kind: 'game', type });
    r.game = newGame(type);
    sys(r, `${name} started ${GAME_NAMES[type]}`);
    if (type === 'draw') startRound(r); else emitGame(r);
  });
  socket.on('game:join', () => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type === 'draw' || g.players.length >= 2 || g.players.some((p) => p.id === socket.id)) return;
    g.players.push({ id: socket.id, name });
    emitGame(r);
  });
  socket.on('game:leave', () => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type === 'draw') return;
    const i = g.players.findIndex((p) => p.id === socket.id);
    if (i < 0) return;
    g.players.splice(i, 1);
    resetBoard(g, false);
    emitGame(r);
  });
  socket.on('game:move', (m) => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type === 'draw' || g.players.length < 2 || g.winner !== null) return;
    if (g.players[g.turn].id !== socket.id) return;
    if (boardMove(g, g.turn, m)) emitGame(r);
  });
  socket.on('game:reset', () => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type === 'draw' || !g.players.some((p) => p.id === socket.id)) return;
    resetBoard(g, true);
    emitGame(r);
  });
  socket.on('draw:stroke', (s) => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type !== 'draw' || g.phase !== 'drawing' || g.drawer !== socket.id || !s) return;
    const nums = [s.x0, s.y0, s.x1, s.y1].map(Number);
    const w = Number(s.w);
    if (nums.some((n) => !Number.isFinite(n) || n < -0.1 || n > 1.1)) return;
    if (!(w >= 1 && w <= 40) || !/^#[0-9a-f]{6}$/i.test(String(s.c))) return;
    const stroke = { x0: nums[0], y0: nums[1], x1: nums[2], y1: nums[3], c: s.c, w };
    if (g.strokes.length < 8000) g.strokes.push(stroke);
    socket.to(r.code).emit('draw:stroke', stroke);
  });
  socket.on('draw:clear', () => {
    const r = roomOf(socket), g = r && r.game;
    if (!g || g.type !== 'draw' || g.drawer !== socket.id) return;
    g.strokes = [];
    io.to(r.code).emit('draw:clear');
  });

  socket.on('disconnect', () => leave(socket));
});

server.listen(PORT, () => console.log(`Eigakan is open: http://localhost:${PORT}`));
