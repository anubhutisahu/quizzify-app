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

// Health-check (used by Render/Railway to confirm server is up)
app.get('/', (_req, res) => {
  res.json({
    status : 'ok',
    service: 'Quizzify Multiplayer Server',
    rooms  : rooms.size,
    uptime : Math.floor(process.uptime()) + 's'
  });
});

// ── Socket.IO logic ───────────────────────────

io.on('connection', (socket) => {
  console.log(`[+] Connected: ${socket.id}`);

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

    console.log(`[-] ${name} left ${roomId} (${room.participants.size} remaining)`);
  });
});

// ── Start server ──────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 Quizzify server running on port ${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/\n`);
});
