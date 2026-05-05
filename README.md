# Quizzify – AI Quiz Generator from Notes
### With Real-Time Multiplayer Mode (v1.1)

> A Minor Project | B.Tech CSE | Medicaps University, Indore

---

## 📁 Project Structure

```
quizzify/
├── index.html          ← Complete frontend (single file)
└── server/
    ├── server.js       ← Node.js + Express + Socket.IO backend
    └── package.json
```

---

## 🚀 Running Locally

### Step 1 – Start the Backend

```bash
cd server
npm install
npm start
```
Server runs at `http://localhost:3000`

### Step 2 – Open the Frontend

Just open `index.html` directly in Chrome or Edge.

> For **single-player only** (no multiplayer), you don't need the backend at all.

---

## ☁️ Deploying Online

### Backend → Render (free)
1. Push the `server/` folder to a GitHub repo
2. Go to [render.com](https://render.com) → New Web Service
3. Connect your repo, set:
   - **Build command:** `npm install`
   - **Start command:** `node server.js`
4. Copy the deployed URL (e.g. `https://quizzify-server.onrender.com`)

### Frontend → GitHub Pages (free)
1. Put `index.html` at the root of a GitHub repo
2. Go to repo Settings → Pages → Deploy from branch `main`
3. **Update the `SERVER_URL`** in `index.html`:
   ```js
   const SERVER_URL = 'https://quizzify-server.onrender.com'; // your Render URL
   ```

---

## 🎮 How to Use

### Single Player
1. Enter your name
2. Choose **Single Player**
3. Upload your PDF or TXT notes
4. AI generates 5 MCQs instantly
5. Take the quiz, see your score + leaderboard

### Multiplayer
1. Enter your name → **Multiplayer**
2. **Host:** Click "Create Room" → share the 6-char Room ID
3. **Players:** Enter Room ID → "Join Room"
4. Host uploads notes → "Start Quiz for Everyone"
5. All players answer simultaneously → live leaderboard updates in real time

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | HTML5, CSS3, Vanilla JS |
| AI | Puter.js (free, no API key) |
| Real-time | Socket.IO 4.x |
| Backend | Node.js 18 + Express 4 |
| PDF Parsing | PDF.js (CDN) |
| Hosting | Render (backend) + GitHub Pages (frontend) |

---

## 📋 Socket.IO Events

| Event | Direction | Description |
|-------|-----------|-------------|
| `create-room` | Client→Server | Host creates a new room |
| `join-room` | Client→Server | Participant joins room |
| `start-quiz` | Client→Server | Host starts quiz with questions |
| `submit-answer` | Client→Server | Player submits answer |
| `end-quiz` | Client→Server | Host signals quiz end |
| `room-created` | Server→Client | Returns roomId to host |
| `room-joined` | Server→Client | Confirms join + participant list |
| `player-joined` | Server→Room | New player broadcast |
| `quiz-started` | Server→Room | Questions broadcast to all |
| `answer-result` | Server→Client | Personal correct/wrong result |
| `update-leaderboard` | Server→Room | Live score broadcast |
| `quiz-ended` | Server→Room | Final leaderboard |
| `player-disconnected` | Server→Room | Player left notification |

---

*Quizzify – Medicaps University, Indore | B.Tech CSE Minor Project 2026*
