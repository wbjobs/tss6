const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const initSqlJs = require('sql.js');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

const DB_PATH = './conductor_data.db';
let db = null;
let insertStmt = null;

const C_MAJOR_SCALE = [261.63, 293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25];

async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS beats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL,
      hand TEXT NOT NULL,
      velocity REAL NOT NULL,
      intensity REAL NOT NULL,
      note INTEGER NOT NULL
    )
  `);

  saveDatabase();
  console.log('Database initialized');
}

function saveDatabase() {
  if (!db) return;
  try {
    const data = db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(DB_PATH, buffer);
  } catch (e) {
    console.error('Error saving database:', e);
  }
}

function insertBeat(timestamp, hand, velocity, intensity, note) {
  if (!db) return;
  try {
    db.run(
      'INSERT INTO beats (timestamp, hand, velocity, intensity, note) VALUES (?, ?, ?, ?, ?)',
      [timestamp, hand, velocity, intensity, note]
    );
  } catch (e) {
    console.error('Error inserting beat:', e);
  }
}

setInterval(() => {
  saveDatabase();
}, 5000);

class BeatDetector {
  constructor(hand) {
    this.hand = hand;
    this.prevWrist = null;
    this.prevTime = null;
    this.velocityHistory = [];
    this.lastBeatTime = 0;
    this.minBeatInterval = 250;
    this.velocityThreshold = 0.0015;
    this.zeroVelocityThreshold = 0.0003;
    this.currentIntensity = 0;
    this.scaleIndex = 0;
  }

  update(wrist, timestamp) {
    if (!this.prevWrist || !this.prevTime) {
      this.prevWrist = wrist;
      this.prevTime = timestamp;
      return { beat: false, intensity: this.currentIntensity };
    }

    const dt = timestamp - this.prevTime;
    if (dt === 0) {
      return { beat: false, intensity: this.currentIntensity };
    }

    const dx = wrist.x - this.prevWrist.x;
    const dy = wrist.y - this.prevWrist.y;
    const dz = wrist.z - this.prevWrist.z;
    const velocity = Math.sqrt(dx * dx + dy * dy + dz * dz) / (dt / 1000);

    this.velocityHistory.push(velocity);
    if (this.velocityHistory.length > 5) {
      this.velocityHistory.shift();
    }

    const avgVelocity = this.velocityHistory.reduce((a, b) => a + b, 0) / this.velocityHistory.length;
    this.currentIntensity = Math.min(1, avgVelocity * 100);

    let beat = false;
    if (
      velocity < this.zeroVelocityThreshold &&
      this.velocityHistory.length >= 3 &&
      this.velocityHistory[0] > this.velocityThreshold &&
      timestamp - this.lastBeatTime > this.minBeatInterval
    ) {
      beat = true;
      this.lastBeatTime = timestamp;
    }

    this.prevWrist = wrist;
    this.prevTime = timestamp;

    return { beat, intensity: this.currentIntensity, velocity };
  }

  getNextNote() {
    const freq = C_MAJOR_SCALE[this.scaleIndex % C_MAJOR_SCALE.length];
    this.scaleIndex++;
    return freq;
  }
}

const leftDetector = new BeatDetector('left');
const rightDetector = new BeatDetector('right');

function broadcast(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

wss.on('connection', (ws) => {
  console.log('Client connected');

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      const timestamp = Date.now();

      const result = {
        timestamp,
        leftBeat: false,
        rightBeat: false,
        leftIntensity: leftDetector.currentIntensity,
        rightIntensity: rightDetector.currentIntensity,
        leftVelocity: 0,
        rightVelocity: 0
      };

      if (data.leftWrist) {
        const leftResult = leftDetector.update(data.leftWrist, timestamp);
        result.leftBeat = leftResult.beat;
        result.leftIntensity = leftResult.intensity;
        result.leftVelocity = leftResult.velocity || 0;

        if (leftResult.beat) {
          const noteFreq = leftDetector.getNextNote();
          result.leftNote = noteFreq;
          insertBeat(timestamp, 'left', leftResult.velocity || 0, leftResult.intensity, Math.round(noteFreq));
        }
      }

      if (data.rightWrist) {
        const rightResult = rightDetector.update(data.rightWrist, timestamp);
        result.rightBeat = rightResult.beat;
        result.rightIntensity = rightResult.intensity;
        result.rightVelocity = rightResult.velocity || 0;

        if (rightResult.beat) {
          const noteFreq = rightDetector.getNextNote();
          result.rightNote = noteFreq;
          insertBeat(timestamp, 'right', rightResult.velocity || 0, rightResult.intensity, Math.round(noteFreq));
        }
      }

      broadcast(result);
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected');
  });
});

async function start() {
  await initDatabase();
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

start();
