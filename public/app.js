(() => {
'use strict';

/* ---------- helpers ---------- */
const $ = (s) => document.querySelector(s);
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat()) if (kid != null) e.append(kid);
  return e;
}
async function api(path, body) {
  const r = await fetch('/api/' + path, {
    method: body ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
let toastTimer;
function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

/* ---------- state ---------- */
let me = null;          // username
let socket = null;
let roomCode = null;
let myId = null;
let members = [];
let stage = { kind: 'none' };
let game = null;
let player = null;      // { apply(stage), destroy() } for synced media
let gameUI = null;
let quietUntil = 0;     // while "quiet", local player events are not broadcast
let myWord = null;
const localFiles = new Map(); // file name -> object URL
const screen = $('#screen');
const MEDIA = ['video', 'youtube', 'file'];
const GAME_NAMES = { ttt: 'Tic-Tac-Toe', four: 'Four in a Row', draw: 'Draw & Guess' };

const quiet = (ms = 1000) => { quietUntil = Date.now() + ms; };
const isQuiet = () => Date.now() < quietUntil;
const stamp = (s) => { s._at = Date.now(); return s; };
const targetTime = (s) => (s.playing ? s.time + (Date.now() - s._at) / 1000 : s.time);

/* ---------- views & routing ---------- */
const views = { auth: $('#auth'), lobby: $('#lobby'), room: $('#room') };
function show(name) { for (const [k, v] of Object.entries(views)) v.hidden = k !== name; }
function roomFromHash() {
  const c = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  return /^[A-Z0-9]{3,12}$/.test(c) ? c : null;
}
function route() {
  if (!me) { leaveRoom(); return show('auth'); }
  $('#lobbyName').textContent = me;
  $('#meName').textContent = me;
  const code = roomFromHash();
  if (code) enterRoom(code);
  else { leaveRoom(); show('lobby'); }
}
window.addEventListener('hashchange', route);

/* ---------- auth ---------- */
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  $('#tabLogin').classList.toggle('active', mode === 'login');
  $('#tabRegister').classList.toggle('active', mode === 'register');
  $('#authSubmit').textContent = mode === 'login' ? 'Enter the theater' : 'Create my account';
  $('#authPass').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  $('#authError').textContent = '';
}
$('#tabLogin').onclick = () => setAuthMode('login');
$('#tabRegister').onclick = () => setAuthMode('register');
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const r = await api(authMode, { username: $('#authUser').value, password: $('#authPass').value });
    me = r.name;
    $('#authPass').value = '';
    route();
  } catch (err) { $('#authError').textContent = err.message; }
};
async function logout() {
  await api('logout', {}).catch(() => {});
  me = null;
  leaveRoom();
  if (socket) { socket.disconnect(); socket = null; }
  route();
}
$('#logoutBtn').onclick = logout;
$('#logoutBtn2').onclick = logout;

/* ---------- lobby ---------- */
$('#newRoom').onclick = () => {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const rnd = crypto.getRandomValues(new Uint8Array(5));
  location.hash = [...rnd].map((n) => abc[n % abc.length]).join('');
};
$('#joinForm').onsubmit = (e) => {
  e.preventDefault();
  const code = $('#joinCode').value.trim().toUpperCase();
  if (!/^[A-Z0-9]{3,12}$/.test(code)) return toast('Codes are 3–12 letters or numbers');
  location.hash = code;
};
$('#leaveBtn').onclick = () => { location.hash = ''; };
$('#copyLink').onclick = async () => {
  try { await navigator.clipboard.writeText(location.href); toast('Invite link copied — send it to your friends'); }
  catch { prompt('Copy this link:', location.href); }
};

/* ---------- socket ---------- */
function ensureSocket() {
  if (socket) return;
  socket = io({ autoConnect: false });
  socket.on('connect', () => { if (roomCode) join(); });
  socket.on('connect_error', (err) => {
    if (err && err.message === 'unauthorized') { me = null; route(); }
  });
  socket.on('members', (m) => { members = m; renderMembers(); prunePeers(); });
  socket.on('chat', addChat);
  socket.on('stage', (s) => setStage(stamp(s)));
  socket.on('sync', (s) => {
    if (!MEDIA.includes(stage.kind)) return;
    Object.assign(stage, { playing: s.playing, time: s.time });
    stamp(stage);
    if (player) player.apply(stage);
  });
  socket.on('game', (g) => { game = g; updateGame(); });
  socket.on('draw:word', (w) => { myWord = w; updateGame(); });
  socket.on('draw:stroke', (s) => { if (gameUI && gameUI.stroke) gameUI.stroke(s); });
  socket.on('draw:clear', () => { if (gameUI && gameUI.clear) gameUI.clear(); });
  socket.on('share:want', onShareWant);
  socket.on('rtc', onRtc);
}
function enterRoom(code) {
  show('room');
  if (roomCode === code) return;
  roomCode = code;
  $('#roomCode').textContent = code;
  ensureSocket();
  if (socket.connected) join(); else socket.connect();
}
function join() {
  socket.emit('join', roomCode, (res) => {
    if (res.error) { toast(res.error); roomCode = null; location.hash = ''; return; }
    myId = res.id;
    members = res.members;
    game = res.game;
    $('#chatLog').replaceChildren();
    res.chat.forEach(addChat);
    renderMembers();
    setStage(stamp(res.stage), true);
    setTimeout(() => $('#proscenium').classList.add('open'), 250);
  });
}
function leaveRoom() {
  if (!roomCode) return;
  roomCode = null;
  stage = { kind: 'none' };
  teardownStage();
  $('#proscenium').classList.remove('open');
  if (socket) socket.disconnect();
}

/* ---------- audience & chat ---------- */
function renderMembers() {
  const seats = members.map((m) => el('div', { class: 'seat' + (m.id === myId ? ' me' : '') },
    el('div', { class: 'head' }), el('div', { class: 'back', text: m.name[0].toUpperCase() }),
    el('div', { class: 'name', text: m.name })));
  for (let i = members.length; i < Math.max(8, members.length); i++) {
    seats.push(el('div', { class: 'seat empty' }, el('div', { class: 'head' }), el('div', { class: 'back' }), el('div', { class: 'name' })));
  }
  $('#seats').replaceChildren(...seats);
}
function addChat(m) {
  const log = $('#chatLog');
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  log.append(m.sys
    ? el('div', { class: 'msg sys', text: m.text })
    : el('div', { class: 'msg' + (m.name === me ? ' mine' : '') }, el('b', { text: m.name }), m.text));
  if (stick) log.scrollTop = log.scrollHeight;
}
$('#chatForm').onsubmit = (e) => {
  e.preventDefault();
  const input = $('#chatInput');
  if (input.value.trim() && socket) socket.emit('chat', input.value);
  input.value = '';
};

/* ---------- stage: the big screen ---------- */
function setStage(s, force) {
  const same = !force && s.kind === stage.kind && s.src === stage.src && s.sharer === stage.sharer && s.type === stage.type;
  stage = s;
  if (same) { if (player) player.apply(stage); return; }
  teardownStage();
  buildStage();
}
function teardownStage() {
  if (player) { player.destroy(); player = null; }
  if (gameUI) { if (gameUI.destroy) gameUI.destroy(); gameUI = null; }
  closePeers();
  if (localStream && !(stage.kind === 'share' && stage.sharer === myId)) stopLocalStream();
  screen.replaceChildren();
  screen.classList.remove('idle');
}
function buildStage() {
  const title = $('#nowShowing');
  $('#btnShare').textContent = stage.kind === 'share' && stage.sharer === myId ? '⏹ Stop sharing' : '🖥️ Share my screen';
  switch (stage.kind) {
    case 'video': {
      let host = 'video';
      try { host = new URL(stage.src).hostname; } catch {}
      title.textContent = 'Now showing · ' + host;
      player = videoPlayer(stage.src);
      break;
    }
    case 'file':
      title.textContent = 'Now showing · ' + stage.src;
      if (localFiles.has(stage.src)) player = videoPlayer(localFiles.get(stage.src));
      else needFile();
      break;
    case 'youtube':
      title.textContent = 'Now showing · YouTube';
      player = ytPlayer(stage.src);
      break;
    case 'share':
      title.textContent = stage.sharer === myId ? 'You are sharing your screen' : `${stage.name}'s screen`;
      buildShare();
      break;
    case 'game':
      title.textContent = 'Game night · ' + (GAME_NAMES[stage.type] || '');
      updateGame();
      break;
    default:
      title.textContent = 'Intermission';
      screen.classList.add('idle');
      screen.append(el('div', { class: 'idle-msg' }, el('b', { text: 'Intermission' }),
        el('span', { text: 'Play a link or a file, share your screen, or start a game — everyone here sees the same thing.' })));
  }
}
function overlay(text, label, onClick) {
  const o = el('div', { class: 'overlay' }, el('div', { text }),
    label ? el('button', { class: 'btn gold', text: label, onclick: () => onClick(o) }) : null);
  screen.append(o);
  return o;
}
function refreshStage(force) {
  socket.emit('stage:get', (s) => setStage(stamp(s), force));
}

/* synced <video> (links and local files) */
function videoPlayer(src) {
  const v = el('video', { controls: '', playsinline: '', preload: 'auto' });
  v.src = src;
  screen.append(v);
  let tap = null;
  const report = () => {
    Object.assign(stage, { playing: !v.paused, time: v.currentTime });
    stamp(stage);
    socket.emit('stage:ctl', { playing: stage.playing, time: stage.time });
  };
  const apply = (s) => {
    const go = () => {
      const t = targetTime(s);
      const drift = Math.abs(v.currentTime - t) > 0.75;
      if (!drift && v.paused !== s.playing) return;
      quiet();
      if (drift) v.currentTime = t;
      if (s.playing && v.paused) {
        v.play().catch(() => {
          if (tap || !v.isConnected) return;
          tap = overlay('The show has started.', '▶ Join playback', (o) => { o.remove(); tap = null; refreshStage(); });
        });
      } else if (!s.playing) v.pause();
    };
    if (v.readyState >= 1) go(); else v.addEventListener('loadedmetadata', go, { once: true });
  };
  v.addEventListener('play', () => {
    if (isQuiet()) return;
    if (stage.playing) apply(stage); else report(); // already playing for the room → just catch up
  });
  v.addEventListener('pause', () => { if (!isQuiet() && !v.ended) report(); });
  v.addEventListener('seeked', () => { if (!isQuiet()) report(); });
  v.addEventListener('error', () => {
    if (v.isConnected) overlay("This video couldn't be loaded. The link must point straight at a video file (.mp4 / .webm) that allows playback from other sites. For anything else, use “Share my screen”.");
  });
  apply(stage);
  return { apply, destroy() { v.pause(); v.removeAttribute('src'); v.load(); } };
}
function needFile() {
  overlay(`${stage.by} is playing “${stage.src}” from their device. Pick your own copy of the same file to watch in sync.`,
    'Choose the file', () => {
      const inp = el('input', { type: 'file', accept: 'video/*,audio/*,.mkv' });
      inp.onchange = () => {
        if (!inp.files[0] || stage.kind !== 'file') return;
        localFiles.set(stage.src, URL.createObjectURL(inp.files[0]));
        refreshStage(true);
      };
      inp.click();
    });
}

/* synced YouTube */
let ytApi = null;
function loadYT() {
  if (!ytApi) {
    ytApi = new Promise((res) => {
      window.onYouTubeIframeAPIReady = res;
      document.head.append(el('script', { src: 'https://www.youtube.com/iframe_api' }));
    });
  }
  return ytApi;
}
function ytPlayer(id) {
  const holder = el('div');
  screen.append(holder);
  let p = null, dead = false, ready = false, started = false;
  const apply = (s) => {
    if (!ready) return;
    const t = targetTime(s);
    const st = p.getPlayerState();
    const playing = st === 1 || st === 3;
    const drift = Math.abs(p.getCurrentTime() - t) > 1;
    if (!drift && playing === s.playing) return;
    quiet(1500);
    if (drift) p.seekTo(t, true);
    if (s.playing) p.playVideo(); else p.pauseVideo();
  };
  loadYT().then(() => {
    if (dead) return;
    p = new YT.Player(holder, {
      videoId: id, width: '100%', height: '100%',
      playerVars: { playsinline: 1, rel: 0 },
      events: {
        onReady() { ready = true; apply(stage); },
        onStateChange(e) {
          if (e.data === 1 && !started) {
            started = true;
            if (stage.playing) return apply(stage); // late start → catch up, don't rewind the room
          }
          if (isQuiet() || (e.data !== 1 && e.data !== 2)) return;
          Object.assign(stage, { playing: e.data === 1, time: p.getCurrentTime() });
          stamp(stage);
          socket.emit('stage:ctl', { playing: stage.playing, time: stage.time });
        },
      },
    });
  });
  return { apply, destroy() { dead = true; try { if (p) p.destroy(); } catch {} } };
}

// gentle drift correction
setInterval(() => {
  if (player && socket && socket.connected && MEDIA.includes(stage.kind) && stage.playing) {
    socket.emit('stage:get', (s) => {
      if (s.kind !== stage.kind || s.src !== stage.src || !player) return;
      stage = stamp(s);
      player.apply(stage);
    });
  }
}, 8000);

/* ---------- screen sharing (WebRTC) ---------- */
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };
let localStream = null;
let shareVideo = null;
const peers = new Map(); // socket id -> { pc, chain }

function stopLocalStream() {
  if (!localStream) return;
  localStream.getTracks().forEach((t) => t.stop());
  localStream = null;
}
function closePeers() {
  for (const p of peers.values()) p.pc.close();
  peers.clear();
}
function prunePeers() {
  for (const [id, p] of peers) {
    if (!members.some((m) => m.id === id)) { p.pc.close(); peers.delete(id); }
  }
}
function newPeer(id) {
  if (peers.has(id)) peers.get(id).pc.close();
  const pc = new RTCPeerConnection(ICE);
  const p = { pc, chain: Promise.resolve() };
  peers.set(id, p);
  pc.onicecandidate = (e) => { if (e.candidate) socket.emit('rtc', { to: id, data: { ice: e.candidate } }); };
  return p;
}
const enqueue = (p, fn) => { p.chain = p.chain.then(fn).catch((err) => console.warn('rtc', err)); };

async function startShare() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    return toast('Screen sharing needs a desktop browser and a secure (https) link.');
  }
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 30 } }, audio: true });
  } catch { return; }
  stopLocalStream();
  localStream = stream;
  stream.getVideoTracks()[0].addEventListener('ended', () => {
    if (stage.kind === 'share' && stage.sharer === myId) socket.emit('share:stop');
  });
  socket.emit('share:start');
}
function buildShare() {
  shareVideo = el('video', { autoplay: '', playsinline: '', controls: '' });
  screen.append(shareVideo);
  if (stage.sharer === myId) {
    shareVideo.muted = true;
    shareVideo.srcObject = localStream;
    screen.append(el('div', { class: 'badge', text: '● Live — everyone in the theater can see this' }));
  } else {
    socket.emit('share:want');
  }
}
function onShareWant({ from }) {
  if (!localStream || stage.kind !== 'share' || stage.sharer !== myId) return;
  const p = newPeer(from);
  localStream.getTracks().forEach((t) => p.pc.addTrack(t, localStream));
  enqueue(p, async () => {
    await p.pc.setLocalDescription(await p.pc.createOffer());
    for (const sender of p.pc.getSenders()) {
      if (!sender.track || sender.track.kind !== 'video') continue;
      try {
        const params = sender.getParameters();
        if (params.encodings && params.encodings.length) {
          params.encodings[0].maxBitrate = 4000000;
          await sender.setParameters(params);
        }
      } catch {}
    }
    socket.emit('rtc', { to: from, data: { sdp: p.pc.localDescription } });
  });
}
function onRtc({ from, data }) {
  if (!data) return;
  let p = peers.get(from);
  if (data.sdp && data.sdp.type === 'offer') {
    if (stage.kind !== 'share' || stage.sharer !== from) return;
    p = newPeer(from);
    const video = shareVideo;
    p.pc.ontrack = (e) => {
      if (video.srcObject === e.streams[0]) return;
      video.srcObject = e.streams[0];
      video.play().catch(() => {
        video.muted = true;
        video.play().catch(() => {});
        if (video.isConnected) overlay('Sound is muted by your browser.', '🔊 Turn sound on', (o) => { video.muted = false; video.play(); o.remove(); });
      });
    };
  }
  if (!p) return;
  enqueue(p, async () => {
    if (data.sdp) {
      await p.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        socket.emit('rtc', { to: from, data: { sdp: p.pc.localDescription } });
      }
    } else if (data.ice) {
      await p.pc.addIceCandidate(data.ice);
    }
  });
}

/* ---------- games ---------- */
function updateGame() {
  if (stage.kind !== 'game' || !game) return;
  if (!gameUI || gameUI.type !== game.type) {
    if (gameUI && gameUI.destroy) gameUI.destroy();
    screen.replaceChildren();
    gameUI = game.type === 'draw' ? drawGame() : boardGame(game.type);
  }
  gameUI.update(game);
}

function boardGame(type) {
  const n = type === 'ttt' ? 9 : 42;
  const marks = type === 'ttt' ? ['✕', '◯'] : ['Gold', 'Red'];
  const playersRow = el('div', { class: 'g-players' });
  const status = el('div', { class: 'g-status' });
  const cells = Array.from({ length: n }, (_, i) =>
    el('button', { class: 'cell', 'aria-label': 'cell', onclick: () => socket.emit('game:move', type === 'ttt' ? i : i % 7) }));
  const grid = el('div', { class: 'g-grid' }, cells);
  const again = el('button', { class: 'btn tiny gold', text: 'Play again', onclick: () => socket.emit('game:reset') });
  const stand = el('button', { class: 'btn tiny', text: 'Leave seat', onclick: () => socket.emit('game:leave') });
  const actions = el('div', { class: 'g-actions' }, again, stand);
  screen.append(el('div', { class: 'game ' + type }, playersRow, status, grid, actions));

  return {
    type,
    update(g) {
      const mySeat = g.players.findIndex((p) => p.id === myId);
      const full = g.players.length === 2;
      playersRow.replaceChildren(...[0, 1].map((i) => {
        const p = g.players[i];
        const tag = type === 'ttt' ? el('b', { text: marks[i] }) : el('span', { class: 'mark p' + i });
        return el('div', { class: 'g-seat' + (full && g.winner === null && g.turn === i ? ' turn' : '') }, tag,
          p ? el('span', { text: p.name + (p.id === myId ? ' (you)' : '') })
            : mySeat < 0 ? el('button', { class: 'btn tiny gold', text: 'Take this seat', onclick: () => socket.emit('game:join') })
              : el('span', { text: 'waiting for a friend…' }));
      }));
      if (!full) status.textContent = 'Two players needed — take a seat to play. Everyone else can watch.';
      else if (g.winner === 'draw') status.textContent = "It's a draw!";
      else if (g.winner !== null) status.textContent = `${g.players[g.winner].name} wins! 🎉`;
      else status.textContent = g.turn === mySeat ? 'Your turn' : `${g.players[g.turn].name}'s turn`;
      cells.forEach((c, i) => {
        const v = g.board[i];
        c.className = 'cell' + (v === null ? '' : ' p' + v) + (g.line && g.line.includes(i) ? ' win' : '');
      });
      again.hidden = !(mySeat >= 0 && full);
      stand.hidden = mySeat < 0;
    },
  };
}

function drawGame() {
  const W = 960, H = 540;
  const COLORS = ['#111111', '#e0202c', '#1f6feb', '#2ea043', '#f2cc0c', '#f0883e', '#8957e5', '#8b5a2b', '#ffffff'];
  const word = el('div', { class: 'd-word' });
  const timer = el('div', { class: 'd-timer' });
  const canvas = el('canvas', { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const scores = el('div', { class: 'd-scores' });
  let color = COLORS[0], size = 5, isDrawer = false, drawing = false, last = null, round = -1, endsAt = 0, phase = 'waiting';

  const swatches = COLORS.map((c) => {
    const b = el('button', { class: 'swatch' + (c === color ? ' on' : ''), 'aria-label': 'colour ' + c,
      onclick: () => { color = c; swatches.forEach((s) => s.classList.toggle('on', s === b)); } });
    b.style.background = c;
    return b;
  });
  const sizeInput = el('input', { type: 'range', min: '2', max: '30', value: '5', 'aria-label': 'brush size', oninput: () => { size = Number(sizeInput.value); } });
  const tools = el('div', { class: 'd-tools' }, swatches, sizeInput,
    el('button', { class: 'btn tiny', text: 'Clear', onclick: () => socket.emit('draw:clear') }));

  function clear() { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
  function stroke(s) {
    ctx.strokeStyle = s.c; ctx.lineWidth = s.w; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(s.x0 * W, s.y0 * H); ctx.lineTo(s.x1 * W, s.y1 * H); ctx.stroke();
  }
  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  };
  function move(e) {
    const p = pos(e);
    const s = { x0: last.x, y0: last.y, x1: p.x, y1: p.y, c: color, w: size };
    stroke(s);
    socket.emit('draw:stroke', s);
    last = p;
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (!isDrawer || phase !== 'drawing') return;
    drawing = true; last = pos(e);
    canvas.setPointerCapture(e.pointerId);
    move(e);
  });
  canvas.addEventListener('pointermove', (e) => { if (drawing) move(e); });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  clear();
  screen.append(el('div', { class: 'game draw' },
    el('div', { class: 'd-head' }, word, timer),
    el('div', { class: 'd-body' }, canvas, scores), tools));
  const tick = setInterval(() => {
    timer.textContent = phase === 'drawing' ? Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)) + 's' : '';
  }, 250);

  return {
    type: 'draw', stroke, clear,
    destroy() { clearInterval(tick); },
    update(g) {
      if (g.round !== round) {
        round = g.round; clear(); drawing = false;
        if (g.drawer !== myId) myWord = null;
        if (g.strokes) g.strokes.forEach(stroke);
      }
      phase = g.phase;
      endsAt = Date.now() + g.remaining;
      isDrawer = g.drawer === myId;
      tools.style.visibility = isDrawer && phase === 'drawing' ? 'visible' : 'hidden';
      canvas.classList.toggle('can', isDrawer && phase === 'drawing');
      if (phase === 'reveal') word.textContent = `The word was “${g.word}”`;
      else if (isDrawer) word.textContent = `Draw this: ${myWord || '…'}`;
      else word.textContent = `${g.hint.split('').join(' ')}   —  ${g.drawerName} is drawing. Type your guess in the chat!`;
      const names = new Set([...members.map((m) => m.name), ...Object.keys(g.scores)]);
      scores.replaceChildren(...[...names].sort((a, b) => (g.scores[b] || 0) - (g.scores[a] || 0)).map((n) =>
        el('div', { class: g.guessed.includes(n) ? 'got' : '' },
          el('span', { text: (n === g.drawerName ? '✏️ ' : g.guessed.includes(n) ? '✓ ' : '') + n }),
          el('b', { text: String(g.scores[n] || 0) }))));
    },
  };
}

/* ---------- controls ---------- */
function parseLink(text) {
  let url;
  try { url = new URL(text.trim()); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be' || host === 'youtube.com' || host === 'youtube-nocookie.com') {
    let id = null;
    if (host === 'youtu.be') id = url.pathname.slice(1);
    else if (url.pathname === '/watch') id = url.searchParams.get('v');
    else { const m = url.pathname.match(/^\/(?:embed|shorts|live)\/([\w-]{11})/); if (m) id = m[1]; }
    return id && /^[\w-]{11}$/.test(id) ? { kind: 'youtube', src: id } : null;
  }
  return { kind: 'video', src: url.href };
}
function toggleDrawer(which) {
  for (const id of ['linkForm', 'gameMenu']) {
    const d = $('#' + id);
    d.hidden = id !== which || !d.hidden;
  }
  if (which === 'linkForm' && !$('#linkForm').hidden) $('#linkInput').focus();
}
$('#btnLink').onclick = () => toggleDrawer('linkForm');
$('#btnGames').onclick = () => toggleDrawer('gameMenu');
$('#linkForm').onsubmit = (e) => {
  e.preventDefault();
  const parsed = parseLink($('#linkInput').value);
  if (!parsed) return toast("That doesn't look like a video link.");
  socket.emit('stage:set', parsed);
  $('#linkInput').value = '';
  toggleDrawer(null);
};
$('#gameMenu').onclick = (e) => {
  const b = e.target.closest('[data-game]');
  if (!b) return;
  socket.emit('game:start', b.dataset.game);
  toggleDrawer(null);
};
$('#btnFile').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  if (localFiles.has(f.name)) URL.revokeObjectURL(localFiles.get(f.name));
  localFiles.set(f.name, URL.createObjectURL(f));
  socket.emit('stage:set', { kind: 'file', src: f.name });
  toast('Your friends will be asked to pick their own copy of this file.');
};
$('#btnShare').onclick = () => {
  if (stage.kind === 'share' && stage.sharer === myId) socket.emit('share:stop');
  else startShare();
};
$('#btnClear').onclick = () => socket.emit('stage:set', { kind: 'none' });
$('#btnFull').onclick = () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else if (screen.requestFullscreen) screen.requestFullscreen();
};

/* ---------- boot ---------- */
(async () => {
  try { me = (await api('me')).name; } catch { me = null; }
  route();
})();
})();
