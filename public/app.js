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
const GAME_NAMES = { ttt: 'Tic-Tac-Toe', four: 'Four in a Row', draw: 'Draw & Guess', brawl: 'Slam Night', kick: 'Kickoff' };

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
  socket.on('arcade', (v) => { if (gameUI && gameUI.frame) gameUI.frame(v); });
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
  const seat = (m) => el('div', { class: 'seat' + (m ? '' : ' empty') + (m && m.id === myId ? ' me' : '') },
    el('div', { class: 'head' }),
    el('div', { class: 'back' }, m ? [el('b', { text: m.name[0].toUpperCase() }), el('span', { text: m.name })] : []));
  const NEAR = 6, FAR = 5;
  const near = members.slice(0, NEAR), far = members.slice(NEAR);
  const pad = (list, n) => [...list.map(seat), ...Array.from({ length: Math.max(0, n - list.length) }, () => seat(null))];
  $('#seats').replaceChildren(
    el('div', { class: 'seat-row far' }, pad(far, FAR)),
    el('div', { class: 'seat-row' }, pad(near, NEAR)));
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
  $('#btnShare').textContent = stage.kind === 'share' && stage.sharer === myId ? '⏹ Stop' : '🖥️ Share';
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
    gameUI = game.type === 'draw' ? drawGame() : game.arcade ? arcadeGame(game.type) : boardGame(game.type);
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

/* ---------- real-time games (Slam Night, Kickoff) ---------- */
const KEYMAP = { arrowleft: 'l', a: 'l', arrowright: 'r', d: 'r', arrowup: 'u', w: 'u', arrowdown: 'd', s: 'd',
  j: 'a', z: 'a', ' ': 'a', k: 'b', x: 'b', l: 'c', c: 'c' };
const HELP = {
  brawl: 'Move ← → (A D) · Jump ↑ (W) · Block ↓ (S) · Punch J · Kick K · Body slam L when your meter is full',
  kick: 'Move with arrows or WASD · Shoot J or Space · Pass K · You control the player with the white ring',
};
const TEAM = ['#f2c230', '#3b82f6'];

function arcadeGame(type) {
  const W = 960, H = 540;
  const playersRow = el('div', { class: 'g-players' });
  const status = el('div', { class: 'g-status' });
  const canvas = el('canvas', { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const again = el('button', { class: 'btn tiny gold', text: 'Rematch', onclick: () => socket.emit('game:reset') });
  const stand = el('button', { class: 'btn tiny', text: 'Leave seat', onclick: () => socket.emit('game:leave') });
  screen.append(el('div', { class: 'game arcade-game' }, playersRow, canvas));
  let g = null, view = null, mySeat = -1, sent = '';
  const keys = {};
  const names = () => [0, 1].map((i) => (g && g.players[i] ? g.players[i].name : 'Player ' + (i + 1)));

  function send() {
    const msg = JSON.stringify(keys);
    if (msg !== sent) { sent = msg; socket.emit('game:input', keys); }
  }
  function onKey(e) {
    if (mySeat < 0 || !g || !g.running) return;
    if (/^(INPUT|TEXTAREA)$/.test(document.activeElement && document.activeElement.tagName)) return;
    const k = KEYMAP[e.key.toLowerCase()];
    if (!k) return;
    e.preventDefault();
    keys[k] = e.type === 'keydown';
    send();
  }
  function onBlur() { for (const k in keys) keys[k] = false; send(); }
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKey);
  window.addEventListener('blur', onBlur);

  function banner(text, sub) {
    ctx.save();
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(20,0,2,.55)'; ctx.fillRect(0, H / 2 - 70, W, sub ? 150 : 110);
    ctx.fillStyle = '#ffe9b0'; ctx.font = 'italic 700 64px Georgia, serif';
    ctx.fillText(text, W / 2, H / 2 + 5);
    if (sub) { ctx.font = '20px system-ui, sans-serif'; ctx.fillStyle = '#fff'; ctx.fillText(sub, W / 2, H / 2 + 50); }
    ctx.restore();
  }

  /* --- wrestling --- */
  function drawFighter(p, i) {
    const skin = i ? '#c98a62' : '#f0c39a', trunks = TEAM[i];
    const X = p.x * 1.2, Y = 432 - p.y;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,.35)';
    ctx.beginPath(); ctx.ellipse(X, 436, 46, 9, 0, 0, 7); ctx.fill();
    ctx.translate(X, Y); ctx.scale(p.face, 1);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const limb = (pts, w, col) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(pts[0], pts[1]);
      for (let k = 2; k < pts.length; k += 2) ctx.lineTo(pts[k], pts[k + 1]);
      ctx.stroke();
    };
    if (p.st === 'down') {
      limb([-58, -14, 20, -14], 34, skin); limb([-10, -14, 22, -14], 36, trunks);
      limb([22, -12, 78, -10], 14, skin); limb([22, -18, 74, -22], 14, skin);
      ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(-76, -16, 17, 0, 7); ctx.fill();
      ctx.fillStyle = trunks; ctx.fillRect(-93, -26, 34, 8);
      ctx.restore(); return;
    }
    if (p.st === 'hit') ctx.rotate(-0.22);
    if (p.st === 'block') ctx.translate(0, 8);
    const sw = p.st === 'walk' ? Math.sin(Date.now() / 70) * 14 : 0;
    // legs
    if (p.st === 'kick') { limb([0, -72, -16, -36, -22, 0], 15, skin); limb([4, -72, 44, -74, 92, -66], 15, skin); }
    else if (p.st === 'jump') { limb([0, -72, -20, -44, -8, -18], 15, skin); limb([4, -72, 26, -46, 14, -18], 15, skin); }
    else { limb([0, -72, -14 + sw, -36, -18 + sw, 0], 15, skin); limb([4, -72, 16 - sw, -36, 18 - sw, 0], 15, skin); }
    // torso + trunks
    limb([0, -128, 2, -84], 38, skin);
    limb([1, -86, 2, -72], 38, trunks);
    // arms
    if (p.st === 'punch') {
      limb([4, -126, -18, -104, -6, -96], 13, skin); limb([6, -128, 44, -124, 84, -122], 13, skin);
      ctx.fillStyle = trunks; ctx.beginPath(); ctx.arc(88, -122, 10, 0, 7); ctx.fill();
    } else if (p.st === 'block') { limb([2, -126, 26, -110, 30, -146], 13, skin); limb([8, -126, 34, -112, 40, -146], 13, skin); }
    else if (p.st === 'slam' || p.st === 'jump') { limb([-4, -128, -24, -160, -14, -190], 13, skin); limb([8, -128, 30, -160, 24, -190], 13, skin); }
    else { limb([-2, -126, -18, -100, 2, -96], 13, skin); limb([6, -126, 28, -104, 36, -128], 13, skin); }
    // head with mask band
    ctx.fillStyle = skin; ctx.beginPath(); ctx.arc(3, -152, 18, 0, 7); ctx.fill();
    ctx.fillStyle = trunks; ctx.fillRect(-15, -164, 36, 9);
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(12, -150, 2.5, 0, 7); ctx.fill();
    if (p.st === 'hit') { ctx.fillStyle = '#fff'; ctx.font = '700 30px system-ui'; ctx.fillText('✸', 14, -120); }
    ctx.restore();
  }
  function drawBrawl(v) {
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#12060d'); bg.addColorStop(1, '#2a0a12');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    for (let r = 0; r < 4; r++) for (let x = 0; x < 34; x++) { // crowd
      ctx.fillStyle = ['#3a1820', '#4a2028', '#2c1219'][(x * 7 + r * 3) % 3];
      ctx.beginPath(); ctx.arc(14 + x * 29 + (r % 2) * 14, 150 + r * 26 + ((x * 13) % 7), 12, 0, 7); ctx.fill();
    }
    for (const x of [200, 480, 760]) { // spotlights
      const sp = ctx.createRadialGradient(x, 0, 10, x, 0, 420);
      sp.addColorStop(0, 'rgba(255,240,200,.22)'); sp.addColorStop(1, 'rgba(255,240,200,0)');
      ctx.fillStyle = sp; ctx.fillRect(0, 0, W, H);
    }
    ctx.fillStyle = '#d9dde6'; ctx.beginPath(); ctx.moveTo(40, 418); ctx.lineTo(920, 418); ctx.lineTo(960, 470); ctx.lineTo(0, 470); ctx.fill(); // mat
    ctx.fillStyle = '#7d0a11'; ctx.fillRect(0, 470, W, 70);
    ctx.fillStyle = '#e6c67c'; ctx.font = 'italic 700 30px Georgia, serif'; ctx.textAlign = 'center'; ctx.fillText('SLAM NIGHT', W / 2, 505);
    ['#e0202c', '#f5f5f5', '#e0202c'].forEach((c, k) => {
      ctx.strokeStyle = c; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(34, 262 + k * 46); ctx.lineTo(926, 262 + k * 46); ctx.stroke();
    });
    ctx.fillStyle = '#c9ccd4'; ctx.fillRect(24, 240, 16, 190); ctx.fillRect(920, 240, 16, 190);
    const order = v.f[0].st === 'down' ? [0, 1] : [1, 0];
    order.forEach((i) => drawFighter(v.f[i], i));
    // HUD
    const nm = names();
    v.f.forEach((p, i) => {
      const x0 = i ? 540 : 40, w = 380;
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x0, 22, w, 24);
      ctx.fillStyle = p.hp > 30 ? '#35c46a' : '#e0202c';
      const hw = w * p.hp / 100; ctx.fillRect(i ? x0 + w - hw : x0, 22, hw, 24);
      ctx.strokeStyle = '#e6c67c'; ctx.lineWidth = 2; ctx.strokeRect(x0, 22, w, 24);
      ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(i ? x0 + w - 200 : x0, 52, 200, 9);
      ctx.fillStyle = p.m >= 100 ? '#ffe066' : TEAM[i]; const mw = 2 * p.m; ctx.fillRect(i ? x0 + w - mw : x0, 52, mw, 9);
      ctx.fillStyle = '#fff'; ctx.font = '600 17px system-ui, sans-serif'; ctx.textAlign = i ? 'right' : 'left';
      ctx.fillText(nm[i] + '  ' + '★'.repeat(p.w), i ? x0 + w : x0, 84);
      if (p.m >= 100) { ctx.fillStyle = '#ffe066'; ctx.font = '700 13px system-ui'; ctx.fillText('SLAM READY — press L', i ? x0 + w - 206 : x0 + 206, 62); }
    });
    ctx.textAlign = 'center'; ctx.fillStyle = '#ffe9b0'; ctx.font = '700 34px Georgia, serif'; ctx.fillText(String(v.time), W / 2, 48);
    if (v.msg) {
      banner(v.msg === 'KO' ? 'K.O.!' : v.msg === 'Time' ? "Time's up" : v.msg,
        v.rw != null ? (v.rw >= 0 ? nm[v.rw] + ' takes the round' : 'Round drawn') : '');
    }
  }

  /* --- football --- */
  function drawKick(v) {
    const S = 0.96, OX = 48, OY = 1;
    ctx.fillStyle = '#0c2a12'; ctx.fillRect(0, 0, W, H);
    ctx.save(); ctx.translate(OX, OY); ctx.scale(S, S);
    for (let k = 0; k < 9; k++) { ctx.fillStyle = k % 2 ? '#2f8a3e' : '#35983f'; ctx.fillRect(k * 100, 0, 100, 560); }
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, 900, 560);
    ctx.beginPath(); ctx.moveTo(450, 0); ctx.lineTo(450, 560); ctx.moveTo(520, 280); ctx.arc(450, 280, 70, 0, 7); ctx.stroke();
    ctx.strokeRect(0, 140, 120, 280); ctx.strokeRect(780, 140, 120, 280);
    ctx.fillStyle = 'rgba(255,255,255,.25)'; ctx.fillRect(-24, 205, 24, 150); ctx.fillRect(900, 205, 24, 150);
    ctx.strokeRect(-24, 205, 24, 150); ctx.strokeRect(900, 205, 24, 150);
    v.p.forEach((team, t) => team.forEach(([x, y], i) => {
      ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(x + 3, y + 6, 14, 8, 0, 0, 7); ctx.fill();
      ctx.fillStyle = i === 0 ? (t ? '#1e3a8a' : '#b45309') : TEAM[t];
      ctx.beginPath(); ctx.arc(x, y, 14, 0, 7); ctx.fill();
      ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.stroke();
      if (i === v.c[t]) {
        ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath(); ctx.arc(x, y, 20, 0, 7); ctx.stroke();
        if (t === mySeat) { ctx.fillStyle = '#fff'; ctx.font = '700 13px system-ui'; ctx.textAlign = 'center'; ctx.fillText('YOU', x, y - 26); }
      }
    }));
    ctx.fillStyle = 'rgba(0,0,0,.35)'; ctx.beginPath(); ctx.ellipse(v.b[0] + 3, v.b[1] + 5, 8, 5, 0, 0, 7); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(v.b[0], v.b[1], 8, 0, 7); ctx.fill();
    ctx.strokeStyle = '#111'; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    const nm = names(), mm = Math.floor(v.t / 60), ss = String(v.t % 60).padStart(2, '0');
    ctx.fillStyle = 'rgba(20,0,2,.78)'; ctx.fillRect(W / 2 - 250, 8, 500, 34);
    ctx.font = '600 18px system-ui, sans-serif'; ctx.textBaseline = 'middle';
    ctx.fillStyle = TEAM[0]; ctx.textAlign = 'right'; ctx.fillText(nm[0], W / 2 - 50, 26);
    ctx.fillStyle = TEAM[1]; ctx.textAlign = 'left'; ctx.fillText(nm[1], W / 2 + 50, 26);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.font = '700 22px system-ui'; ctx.fillText(v.s[0] + ' – ' + v.s[1], W / 2, 26);
    ctx.font = '600 15px system-ui'; ctx.textAlign = 'right'; ctx.fillText(mm + ':' + ss, W / 2 + 240, 26);
    ctx.textBaseline = 'alphabetic';
    if (v.msg) banner(v.msg);
  }

  function paint() {
    if (view) (type === 'brawl' ? drawBrawl : drawKick)(view);
    else { ctx.fillStyle = '#1a0103'; ctx.fillRect(0, 0, W, H); }
    if (g && g.running) {
      ctx.fillStyle = 'rgba(20,0,2,.7)'; ctx.fillRect(0, H - 24, W, 24);
      ctx.fillStyle = '#ffe9b0'; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(mySeat >= 0 ? HELP[type] : 'You are watching — live match', W / 2, H - 7);
      return;
    }
    if (!g) return;
    if (g.result) {
      const nm = names();
      banner(g.result.winner === 'draw' ? "It's a draw" : nm[g.result.winner] + ' wins!',
        g.result.score ? g.result.score.join(' – ') : 'Press Rematch to go again');
    } else {
      ctx.textAlign = 'center'; ctx.fillStyle = '#e6c67c'; ctx.font = 'italic 700 58px Georgia, serif';
      ctx.fillText(GAME_NAMES[type], W / 2, 220);
      ctx.fillStyle = '#fff'; ctx.font = '20px system-ui, sans-serif';
      ctx.fillText('Two players take a seat to start. Everyone else watches live.', W / 2, 270);
      ctx.font = '16px system-ui, sans-serif'; ctx.fillStyle = '#ffd9a0';
      ctx.fillText(HELP[type], W / 2, 320);
    }
  }

  return {
    type,
    frame(v) { view = v; paint(); },
    destroy() {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
    },
    update(ng) {
      const wasRunning = g && g.running;
      g = ng;
      mySeat = g.players.findIndex((p) => p.id === myId);
      if (g.running && !wasRunning) { for (const k in keys) keys[k] = false; sent = ''; }
      if (!g.running && !g.result) view = null;
      playersRow.replaceChildren(...[0, 1].map((i) => {
        const p = g.players[i];
        const dot = el('span', { class: 'mark' });
        dot.style.background = TEAM[i];
        return el('div', { class: 'g-seat' }, dot,
          p ? el('span', { text: p.name + (p.id === myId ? ' (you)' : '') })
            : mySeat < 0 ? el('button', { class: 'btn tiny gold', text: 'Take this seat', onclick: () => socket.emit('game:join') })
              : el('span', { text: 'waiting for a friend…' }));
      }), again, stand);
      again.hidden = !(mySeat >= 0 && g.players.length === 2 && !g.running);
      stand.hidden = mySeat < 0;
      paint();
    },
  };
}

/* ---------- the 3D hall: walls, coffered ceiling and floor in one-point perspective ---------- */
function buildHall() {
  const W = 1000, H = 620, X0 = 110, X1 = 890, Y0 = 70, Y1 = 500;
  const L = (a, b, t) => a + (b - a) * t;
  // t = depth (0 at the viewer, 1 at the screen wall); u = position across the surface
  const wall = (side, t, u) => { const x = L(0, X0, t); return [side ? W - x : x, L(L(0, Y0, t), L(H, Y1, t), u)]; };
  const ceil = (u, t) => [L(L(0, X0, t), L(W, X1, t), u), L(0, Y0, t)];
  const floor = (u, t) => [L(L(0, X0, t), L(W, X1, t), u), L(H, Y1, t)];
  const pt = (p) => p[0].toFixed(1) + ',' + p[1].toFixed(1);
  const poly = (ps, attrs) => '<polygon points="' + ps.map(pt).join(' ') + '" ' + attrs + '/>';
  const line = (a, b, attrs) => '<line x1="' + a[0].toFixed(1) + '" y1="' + a[1].toFixed(1) + '" x2="' + b[0].toFixed(1) + '" y2="' + b[1].toFixed(1) + '" ' + attrs + '/>';
  const D = [0, 0.4, 0.66, 0.83, 0.94, 1];
  let s = '<defs>'
    + '<linearGradient id="hWallL" x1="0" x2="1"><stop offset="0" stop-color="#4a0509"/><stop offset="1" stop-color="#a5101a"/></linearGradient>'
    + '<linearGradient id="hWallR" x1="1" x2="0"><stop offset="0" stop-color="#4a0509"/><stop offset="1" stop-color="#a5101a"/></linearGradient>'
    + '<linearGradient id="hCeil" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d0a11"/><stop offset="1" stop-color="#c21824"/></linearGradient>'
    + '<linearGradient id="hFloor" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#1a0103"/><stop offset="1" stop-color="#7d0a11"/></linearGradient>'
    + '<radialGradient id="hGlow"><stop offset="0" stop-color="#fff3c9" stop-opacity=".95"/><stop offset=".25" stop-color="#ffd98a" stop-opacity=".45"/><stop offset="1" stop-color="#ffd98a" stop-opacity="0"/></radialGradient>'
    + '</defs>';
  // ceiling with coffers
  s += poly([[0, 0], [W, 0], [X1, Y0], [X0, Y0]], 'fill="#3f0307"');
  for (let i = 0; i < 5; i++) for (let j = 0; j < 6; j++) {
    const g = (D[i + 1] - D[i]) * 0.1, a = D[i] + g, b = D[i + 1] - g, u0 = (j + 0.06) / 6, u1 = (j + 0.94) / 6;
    s += poly([ceil(u0, a), ceil(u1, a), ceil(u1, b), ceil(u0, b)], 'fill="url(#hCeil)" stroke="#2b0306" stroke-width="1.5"');
    const k = (D[i + 1] - D[i]) * 0.28;
    s += poly([ceil(u0 + 0.03, a + k), ceil(u1 - 0.03, a + k), ceil(u1 - 0.03, b - k), ceil(u0 + 0.03, b - k)], 'fill="#5d060c" opacity=".55"');
  }
  // side walls: panelled bays with draped arches and sconces
  for (const side of [0, 1]) {
    s += poly([wall(side, 0, 0), wall(side, 1, 0), wall(side, 1, 1), wall(side, 0, 1)], 'fill="url(#hWall' + (side ? 'R' : 'L') + ')"');
    for (let i = 0; i < 5; i++) {
      const a = D[i], b = D[i + 1], w = b - a, m = (a + b) / 2;
      s += poly([wall(side, a + w * 0.07, 0.06), wall(side, b - w * 0.07, 0.06), wall(side, b - w * 0.07, 0.86), wall(side, a + w * 0.07, 0.86)],
        'fill="#8f0c15" fill-opacity=".55" stroke="#3f0307" stroke-width="2"');
      const ta = a + w * 0.2, tb = b - w * 0.2;
      s += '<path d="M' + pt(wall(side, ta, 0.84)) + ' L' + pt(wall(side, ta, 0.36)) + ' Q' + pt(wall(side, m, 0.06)) + ' ' + pt(wall(side, tb, 0.36))
        + ' L' + pt(wall(side, tb, 0.84)) + 'Z" fill="#3f0307" stroke="#c21824" stroke-width="2"/>';
      const da = a + w * 0.27, db = b - w * 0.27;
      s += '<path d="M' + pt(wall(side, da, 0.84)) + ' L' + pt(wall(side, da, 0.42)) + ' Q' + pt(wall(side, m, 0.2)) + ' ' + pt(wall(side, db, 0.42))
        + ' L' + pt(wall(side, m + w * 0.04, 0.6)) + ' L' + pt(wall(side, db, 0.84)) + 'Z" fill="url(#velvet)" opacity=".85"/>';
    }
    for (let i = 1; i < 5; i++) {
      const d = D[i];
      s += line(wall(side, d, 0.02), wall(side, d, 0.98), 'stroke="#5d060c" stroke-width="' + L(12, 4, d) + '"');
      const c = wall(side, d, 0.47), r = L(34, 12, d);
      s += '<circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + r + '" fill="url(#hGlow)"/><circle cx="' + c[0] + '" cy="' + c[1] + '" r="' + r / 7 + '" fill="#fff6d8"/>';
    }
    s += line(wall(side, 0, 0.9), wall(side, 1, 0.9), 'stroke="#3f0307" stroke-width="4"');
    s += line(wall(side, 0, 0.03), wall(side, 1, 0.03), 'stroke="#e6c67c" stroke-opacity=".5" stroke-width="2"');
  }
  // floor: carpet, centre aisle and the lit steps in front of the stage
  s += poly([floor(0, 0), floor(1, 0), floor(1, 1), floor(0, 1)], 'fill="url(#hFloor)"');
  s += poly([floor(0.4, 0), floor(0.6, 0), floor(0.56, 1), floor(0.44, 1)], 'fill="#ff8f8f" opacity=".08"');
  for (const t of [0.72, 0.84, 0.94]) {
    s += line(floor(0.08, t), floor(0.92, t), 'stroke="#ff7a5c" stroke-width="' + L(16, 8, t) + '" opacity=".18"');
    s += line(floor(0.08, t), floor(0.92, t), 'stroke="#ffb199" stroke-width="' + L(5, 2.5, t) + '" opacity=".8"');
  }
  $('#hallArt').innerHTML = s;
  // chandeliers hang in front of the side drapes, on their own layer above the stage
  let lamps = '';
  for (const cx of [116, W - 116]) {
    const h = 150, w = h * 0.8;
    lamps += '<circle cx="' + cx + '" cy="' + (8 + h * 0.62) + '" r="' + h * 0.8 + '" fill="url(#hGlow)" opacity=".85"/>';
    lamps += '<use class="lamp" href="#chandelier" x="' + (cx - w / 2) + '" y="8" width="' + w + '" height="' + h + '"/>';
  }
  $('#hallLamps').innerHTML = lamps;
}
buildHall();

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
