/**
 * Quizzify – Backend Server
 * Node.js + Express + Socket.IO
 * Handles real-time multiplayer quiz sessions
 *
 * Socket Events (Client → Server):
 *   create-room  : host creates a new room
 *   join-room    : participant joins existing room
 *   start-quiz   : host starts the quiz for all in room
 *   submit-answer: player submits an answer
 *   disconnect   : player disconnects (auto)
 *
 * Socket Events (Server → Client):
 *   room-created      : returns unique roomId to host
 *   room-joined       : confirms join, returns participant list
 *   player-joined     : broadcast new participant to room
 *   quiz-started      : broadcast questions to all in room
 *   answer-result     : returns correct/incorrect to answering player
 *   update-leaderboard: broadcast updated scores to all in room
 *   player-disconnected: broadcast updated participant list
 *   error             : sends error message to client
 */

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const crypto  = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: {
    origin: '*',          // Allow all origins (tighten in production)
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
// In-memory room store
// Map<roomId, RoomObject>
// RoomObject: {
//   roomId      : string,
//   hostId      : string,   (socket.id of host)
//   participants: Map<socketId, { name, score, hasAnswered }>,
//   questions   : Array<{ question, options[4], correctIndex }>,
//   status      : 'waiting' | 'active' | 'ended',
//   createdAt   : Date
// }
// ─────────────────────────────────────────────
const rooms = new Map();

// ── Utilities ────────────────────────────────

/** Generate a unique 6-character uppercase room ID */
function generateRoomId() {
  let id;
  do {
    id = crypto.randomBytes(3).toString('hex').toUpperCase();
  } while (rooms.has(id));
  return id;
}

/** Build a serializable leaderboard array sorted by score */
function buildLeaderboard(participants) {
  return Array.from(participants.entries())
    .map(([socketId, p]) => ({
      socketId,
      name  : p.name,
      score : p.score
    }))
    .sort((a, b) => b.score - a.score);
}

/** Build a safe participant list (no socketIds exposed to all) */
function buildParticipantList(participants) {
  return Array.from(participants.values()).map(p => ({ name: p.name, score: p.score }));
}

// ── HTTP routes ───────────────────────────────

app.use(express.json());

// Track server stats
const serverStats = {
  startTime     : Date.now(),
  totalRooms    : 0,
  totalPlayers  : 0,
  totalQuizzes  : 0,
  peakConnections: 0,
  currentConnections: 0,
  events        : []   // last 20 events
};

function logEvent(msg) {
  const time = new Date().toLocaleTimeString('en-IN', { hour12: false });
  serverStats.events.unshift({ time, msg });
  if (serverStats.events.length > 20) serverStats.events.pop();
}

// ── GET / — Health check (JSON) ──────────────
app.get('/health', (_req, res) => {
  res.json({
    status            : 'ok',
    service           : 'Quizzify Multiplayer Server',
    activeRooms       : rooms.size,
    activeConnections : serverStats.currentConnections,
    uptime            : Math.floor((Date.now() - serverStats.startTime) / 1000) + 's'
  });
});

// ── GET /status — JSON API for status page ───
app.get('/status', (_req, res) => {
  const roomList = Array.from(rooms.values()).map(r => ({
    roomId      : r.roomId,
    status      : r.status,
    players     : Array.from(r.participants.values()).map(p => ({ name: p.name, score: p.score })),
    playerCount : r.participants.size,
    questions   : r.questions.length,
    createdAt   : r.createdAt
  }));

  res.json({
    status            : 'online',
    uptime            : Math.floor((Date.now() - serverStats.startTime) / 1000),
    activeRooms       : rooms.size,
    activeConnections : serverStats.currentConnections,
    totalRooms        : serverStats.totalRooms,
    totalPlayers      : serverStats.totalPlayers,
    totalQuizzes      : serverStats.totalQuizzes,
    peakConnections   : serverStats.peakConnections,
    rooms             : roomList,
    recentEvents      : serverStats.events
  });
});

// ── GET / — Live Admin Dashboard (HTML) ──────
app.get('/', (_req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Quizzify — Server Dashboard</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Syne:wght@700;800&family=DM+Sans:wght@300;400;500;600&display=swap');
    :root {
      --bg:#0a0a0f; --bg2:#111118; --bg3:#1a1a26; --surface:#1e1e2e;
      --border:rgba(255,255,255,0.08); --border2:rgba(255,255,255,0.15);
      --accent:#7c6fcd; --accent2:#a78bfa; --gold:#f59e0b; --gold2:#fcd34d;
      --green:#34d399; --red:#f87171; --blue:#60a5fa;
      --text:#f0f0f8; --text2:#a0a0b8;
    }
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{background:var(--bg);color:var(--text);font-family:'DM Sans',sans-serif;min-height:100vh;padding:24px}
    body::before{content:'';position:fixed;top:-20vh;left:50%;transform:translateX(-50%);
      width:80vw;height:60vh;background:radial-gradient(ellipse,rgba(124,111,205,0.1) 0%,transparent 70%);pointer-events:none}
    h1{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;
      background:linear-gradient(135deg,#a78bfa,#fcd34d);-webkit-background-clip:text;
      -webkit-text-fill-color:transparent;background-clip:text;margin-bottom:4px}
    .subtitle{color:var(--text2);font-size:0.85rem;margin-bottom:28px}
    .status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;
      background:var(--green);margin-right:6px;animation:pulse 1.5s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.5;transform:scale(0.7)}}

    /* Stats grid */
    .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:14px;margin-bottom:24px}
    .stat-card{background:var(--surface);border:1px solid var(--border);border-radius:14px;
      padding:20px;position:relative;overflow:hidden}
    .stat-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
      background:linear-gradient(90deg,var(--accent),var(--accent2))}
    .stat-label{font-size:0.72rem;text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:8px}
    .stat-value{font-family:'Syne',sans-serif;font-size:2rem;font-weight:800;
      background:linear-gradient(135deg,var(--accent2),var(--gold2));
      -webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
    .stat-sub{font-size:0.75rem;color:var(--text2);margin-top:4px}

    /* Sections */
    .section{background:var(--surface);border:1px solid var(--border);border-radius:14px;
      padding:20px;margin-bottom:20px;position:relative;overflow:hidden}
    .section::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;
      background:linear-gradient(90deg,var(--gold),var(--gold2));opacity:0.6}
    .section-title{font-family:'Syne',sans-serif;font-size:0.8rem;font-weight:700;
      text-transform:uppercase;letter-spacing:1px;color:var(--text2);margin-bottom:16px}

    /* Rooms */
    .room-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
    .room-card{background:var(--bg3);border:1px solid var(--border);border-radius:10px;padding:16px}
    .room-id{font-family:'Syne',sans-serif;font-size:1.4rem;font-weight:800;
      color:var(--gold2);letter-spacing:4px;margin-bottom:8px}
    .room-status{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;
      border-radius:20px;font-size:0.75rem;font-weight:600;margin-bottom:10px}
    .room-status.waiting{background:rgba(96,165,250,0.1);border:1px solid rgba(96,165,250,0.3);color:var(--blue)}
    .room-status.active{background:rgba(52,211,153,0.1);border:1px solid rgba(52,211,153,0.3);color:var(--green)}
    .room-status.ended{background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);color:var(--red)}
    .player-chip{display:inline-flex;align-items:center;gap:5px;background:rgba(255,255,255,0.05);
      border:1px solid var(--border);border-radius:20px;padding:3px 10px;
      font-size:0.78rem;margin:3px}
    .player-score{color:var(--accent2);font-weight:600;margin-left:4px}
    .empty-state{text-align:center;padding:32px;color:var(--text2);font-size:0.9rem}
    .empty-icon{font-size:2rem;margin-bottom:8px}

    /* Events log */
    .event-log{max-height:220px;overflow-y:auto}
    .event-item{display:flex;gap:12px;padding:8px 0;border-bottom:1px solid var(--border);
      font-size:0.83rem;align-items:flex-start}
    .event-item:last-child{border-bottom:none}
    .event-time{color:var(--accent2);font-weight:600;flex-shrink:0;font-size:0.78rem;
      font-family:monospace;padding-top:1px}
    .event-msg{color:var(--text2)}

    /* Info bar */
    .info-bar{display:flex;align-items:center;justify-content:space-between;
      background:var(--bg3);border:1px solid var(--border);border-radius:10px;
      padding:12px 18px;margin-bottom:24px;flex-wrap:wrap;gap:10px}
    .info-item{font-size:0.82rem;color:var(--text2)}
    .info-item strong{color:var(--text)}
    .refresh-btn{background:rgba(124,111,205,0.15);border:1px solid var(--accent);
      border-radius:8px;padding:6px 14px;color:var(--accent2);font-size:0.82rem;
      cursor:pointer;font-family:'DM Sans',sans-serif;transition:all 0.2s}
    .refresh-btn:hover{background:rgba(124,111,205,0.3)}

    /* Two column layout */
    .two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px}
    @media(max-width:700px){.two-col{grid-template-columns:1fr}}
  </style>
</head>
<body>
  <h1>⚡ Quizzify Dashboard</h1>
  <p class="subtitle"><span class="status-dot"></span>Server is live · Auto-refreshes every 5 seconds</p>

  <div class="info-bar">
    <div class="info-item">🌐 Backend: <strong>https://quizzify-app.onrender.com</strong></div>
    <div class="info-item">🎮 Frontend: <strong>https://anubhutisahu.github.io/quizzify-app</strong></div>
    <div class="info-item" id="last-updated">Last updated: —</div>
    <button class="refresh-btn" onclick="fetchData()">↻ Refresh</button>
  </div>

  <!-- Stats -->
  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-label">Active Rooms</div>
      <div class="stat-value" id="s-rooms">—</div>
      <div class="stat-sub">Currently open</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Live Connections</div>
      <div class="stat-value" id="s-conn">—</div>
      <div class="stat-sub">Socket.IO clients</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Rooms</div>
      <div class="stat-value" id="s-total-rooms">—</div>
      <div class="stat-sub">Since server start</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Total Players</div>
      <div class="stat-value" id="s-total-players">—</div>
      <div class="stat-sub">Since server start</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Quizzes Run</div>
      <div class="stat-value" id="s-quizzes">—</div>
      <div class="stat-sub">Since server start</div>
    </div>
    <div class="stat-card">
      <div class="stat-label">Uptime</div>
      <div class="stat-value" id="s-uptime">—</div>
      <div class="stat-sub">Seconds running</div>
    </div>
  </div>

  <!-- Active rooms -->
  <div class="section">
    <div class="section-title">🏠 Active Rooms</div>
    <div class="room-grid" id="rooms-container">
      <div class="empty-state"><div class="empty-icon">🎮</div>No active rooms yet</div>
    </div>
  </div>

  <!-- Two column: events + tech info -->
  <div class="two-col">
    <div class="section">
      <div class="section-title">📡 Live Event Log</div>
      <div class="event-log" id="event-log">
        <div class="empty-state" style="padding:16px"><div class="empty-icon">📭</div>No events yet</div>
      </div>
    </div>
    <div class="section">
      <div class="section-title">🛠️ Tech Stack</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        ${[
          ['Runtime',    'Node.js v18+'],
          ['Framework',  'Express 4.x'],
          ['WebSockets', 'Socket.IO 4.x'],
          ['AI Engine',  'Pollinations.AI (GPT-4o)'],
          ['PDF Parser', 'PDF.js 3.x'],
          ['Frontend',   'Vanilla HTML/CSS/JS'],
          ['Hosting',    'Render (backend) + GitHub Pages'],
          ['Auth',       'None required — fully open'],
        ].map(([k,v]) => \`
          <div style="display:flex;justify-content:space-between;align-items:center;
            padding:8px 12px;background:var(--bg3);border-radius:8px;font-size:0.83rem">
            <span style="color:var(--text2)">\${k}</span>
            <span style="color:var(--accent2);font-weight:600">\${v}</span>
          </div>\`).join('')}
      </div>
    </div>
  </div>

  <script>
    async function fetchData() {
      try {
        const res  = await fetch('/status');
        const data = await res.json();

        document.getElementById('s-rooms').textContent         = data.activeRooms;
        document.getElementById('s-conn').textContent          = data.activeConnections;
        document.getElementById('s-total-rooms').textContent   = data.totalRooms;
        document.getElementById('s-total-players').textContent = data.totalPlayers;
        document.getElementById('s-quizzes').textContent       = data.totalQuizzes;
        document.getElementById('s-uptime').textContent        = data.uptime + 's';
        document.getElementById('last-updated').textContent    = 'Last updated: ' + new Date().toLocaleTimeString();

        // Rooms
        const rc = document.getElementById('rooms-container');
        if (!data.rooms || data.rooms.length === 0) {
          rc.innerHTML = '<div class="empty-state"><div class="empty-icon">🎮</div>No active rooms right now</div>';
        } else {
          rc.innerHTML = data.rooms.map(r => \`
            <div class="room-card">
              <div class="room-id">\${r.roomId}</div>
              <div class="room-status \${r.status}">\${r.status.toUpperCase()}</div>
              <div style="font-size:0.78rem;color:var(--text2);margin-bottom:8px">
                \${r.questions} questions · \${r.playerCount} player\${r.playerCount !== 1 ? 's' : ''}
              </div>
              <div>\${r.players.map(p =>
                \`<span class="player-chip">👤 \${p.name}<span class="player-score">\${p.score}pts</span></span>\`
              ).join('')}</div>
            </div>\`).join('');
        }

        // Events
        const el = document.getElementById('event-log');
        if (!data.recentEvents || data.recentEvents.length === 0) {
          el.innerHTML = '<div class="empty-state" style="padding:16px"><div class="empty-icon">📭</div>No events yet</div>';
        } else {
          el.innerHTML = data.recentEvents.map(e =>
            \`<div class="event-item"><span class="event-time">\${e.time}</span><span class="event-msg">\${e.msg}</span></div>\`
          ).join('');
        }
      } catch(e) {
        console.error('Dashboard fetch error:', e);
      }
    }

    fetchData();
    setInterval(fetchData, 5000);
  </script>
</body>
</html>`);
});

// ── Socket.IO logic ───────────────────────────

io.on('connection', (socket) => {
  serverStats.currentConnections++;
  if (serverStats.currentConnections > serverStats.peakConnections)
    serverStats.peakConnections = serverStats.currentConnections;
  console.log(`[+] Connected: ${socket.id}`);
  logEvent(`New connection · ${serverStats.currentConnections} active`);

  // ── CREATE ROOM ──────────────────────────────
  // Payload: { name: string }
  socket.on('create-room', ({ name }) => {
    if (!name || !name.trim()) {
      return socket.emit('error', { message: 'Name is required to create a room.' });
    }

    const roomId = generateRoomId();
    const participants = new Map();
    participants.set(socket.id, { name: name.trim(), score: 0, hasAnswered: false });

    rooms.set(roomId, {
      roomId,
      hostId      : socket.id,
      participants,
      questions   : [],
      status      : 'waiting',
      createdAt   : new Date()
    });

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name   = name.trim();
    serverStats.totalRooms++;
    serverStats.totalPlayers++;
    logEvent(`Room ${roomId} created by ${name.trim()}`);

    socket.emit('room-created', {
      roomId,
      participants: buildParticipantList(participants)
    });

    console.log(`[ROOM] Created: ${roomId} by ${name}`);
  });

  // ── JOIN ROOM ────────────────────────────────
  // Payload: { name: string, roomId: string }
  socket.on('join-room', ({ name, roomId }) => {
    if (!name || !name.trim()) {
      return socket.emit('error', { message: 'Name is required to join a room.' });
    }
    if (!roomId || !roomId.trim()) {
      return socket.emit('error', { message: 'Room ID is required.' });
    }

    const room = rooms.get(roomId.toUpperCase().trim());
    if (!room) {
      return socket.emit('error', { message: 'Room not found. Check the Room ID and try again.' });
    }
    if (room.status === 'active') {
      return socket.emit('error', { message: 'Quiz already in progress. You cannot join now.' });
    }
    if (room.status === 'ended') {
      return socket.emit('error', { message: 'This quiz session has ended.' });
    }

    room.participants.set(socket.id, { name: name.trim(), score: 0, hasAnswered: false });
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.name   = name.trim();
    serverStats.totalPlayers++;
    logEvent(`${name.trim()} joined room ${roomId}`);

    // Tell the joining player everything they need
    socket.emit('room-joined', {
      roomId,
      participants: buildParticipantList(room.participants)
    });

    // Tell everyone else a new player joined
    socket.to(roomId).emit('player-joined', {
      name        : name.trim(),
      participants: buildParticipantList(room.participants)
    });

    console.log(`[ROOM] ${name} joined ${roomId} (${room.participants.size} players)`);
  });

  // ── START QUIZ ───────────────────────────────
  // Payload: { roomId: string, questions: Array }
  // Only the host can start the quiz
  socket.on('start-quiz', ({ roomId, questions }) => {
    const room = rooms.get(roomId);
    if (!room) {
      return socket.emit('error', { message: 'Room not found.' });
    }
    if (room.hostId !== socket.id) {
      return socket.emit('error', { message: 'Only the host can start the quiz.' });
    }
    if (room.status !== 'waiting') {
      return socket.emit('error', { message: 'Quiz has already started or ended.' });
    }
    if (!questions || questions.length === 0) {
      return socket.emit('error', { message: 'No questions to start with. Please upload notes first.' });
    }

    room.questions = questions;
    room.status    = 'active';
    serverStats.totalQuizzes++;
    logEvent(`Quiz started in room ${roomId} · ${questions.length} questions · ${room.participants.size} players`);

    // Reset all participant scores and answer flags
    for (const p of room.participants.values()) {
      p.score       = 0;
      p.hasAnswered = false;
    }

    // Broadcast questions to all participants (strip correctIndex for non-host)
    const questionsForAll = questions.map(q => ({
      question   : q.question,
      options    : q.options,
      correctIndex: q.correctIndex  // clients need this to show correct answer after selection
    }));

    io.to(roomId).emit('quiz-started', {
      questions   : questionsForAll,
      totalPlayers: room.participants.size
    });

    console.log(`[QUIZ] Started in ${roomId} with ${questions.length} questions, ${room.participants.size} players`);
  });

  // ── SUBMIT ANSWER ────────────────────────────
  // Payload: { roomId: string, questionIndex: number, selectedIndex: number }
  socket.on('submit-answer', ({ roomId, questionIndex, selectedIndex }) => {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'active') return;

    const participant = room.participants.get(socket.id);
    if (!participant) return;

    const question = room.questions[questionIndex];
    if (!question) return;

    const isCorrect = selectedIndex === question.correctIndex;
    if (isCorrect) {
      participant.score += 1;
    }

    // Send result to the answering player only
    socket.emit('answer-result', {
      questionIndex,
      isCorrect,
      correctIndex: question.correctIndex,
      score       : participant.score
    });

    // Broadcast updated leaderboard to everyone in room
    const leaderboard = buildLeaderboard(room.participants);
    io.to(roomId).emit('update-leaderboard', { leaderboard });

    console.log(`[ANSWER] ${participant.name} Q${questionIndex} → ${isCorrect ? 'correct' : 'wrong'} (score: ${participant.score})`);
  });

  // ── QUIZ ENDED (host signals end) ────────────
  socket.on('end-quiz', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.hostId !== socket.id) return;

    room.status = 'ended';
    const leaderboard = buildLeaderboard(room.participants);
    io.to(roomId).emit('quiz-ended', { leaderboard });

    console.log(`[QUIZ] Ended in ${roomId}`);
  });

  // ── DISCONNECT ───────────────────────────────
  socket.on('disconnect', () => {
    serverStats.currentConnections = Math.max(0, serverStats.currentConnections - 1);
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const participant = room.participants.get(socket.id);
    const name = participant?.name || 'A player';

    room.participants.delete(socket.id);

    // If room is empty, clean it up
    if (room.participants.size === 0) {
      rooms.delete(roomId);
      console.log(`[ROOM] ${roomId} deleted (empty)`);
      return;
    }

    // If host left, assign a new host
    if (room.hostId === socket.id && room.participants.size > 0) {
      const newHostId = room.participants.keys().next().value;
      room.hostId = newHostId;
      io.to(newHostId).emit('host-assigned', { message: 'You are now the host.' });
      console.log(`[HOST] New host assigned in ${roomId}`);
    }

    // Notify remaining participants
    io.to(roomId).emit('player-disconnected', {
      name,
      participants: buildParticipantList(room.participants),
      leaderboard : buildLeaderboard(room.participants)
    });

    logEvent(`${name} left room ${roomId} · ${room.participants.size} remaining`);
    console.log(`[-] ${name} left ${roomId} (${room.participants.size} remaining)`);
  });
});

// ── Start server ──────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Quizzify server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/\n`);
});
