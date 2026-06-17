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

const C_MAJOR_SCALE_STRINGS = [196.00, 220.00, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00];
const C_MAJOR_SCALE_WIND = [261.63, 293.66, 329.66, 349.23, 392.00, 440.00, 493.88, 523.25];

const ROOMS = new Map();

function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

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
      room_id TEXT NOT NULL,
      section TEXT NOT NULL,
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

function insertBeat(timestamp, roomId, section, hand, velocity, intensity, note) {
  if (!db) return;
  try {
    db.run(
      'INSERT INTO beats (timestamp, room_id, section, hand, velocity, intensity, note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [timestamp, roomId, section, hand, velocity, intensity, note]
    );
  } catch (e) {
    console.error('Error inserting beat:', e);
  }
}

setInterval(() => {
  saveDatabase();
}, 5000);

class BeatDetector {
  constructor(hand, scale) {
    this.hand = hand;
    this.scale = scale;
    this.prevWrist = null;
    this.prevTime = null;
    this.prevVelocity = 0;
    this.prevDirection = { x: 0, y: 0, z: 0 };

    this.velocityHistory = [];
    this.directionHistory = [];
    this.peakHistory = [];
    this.interbeatIntervals = [];

    this.lastBeatTime = 0;
    this.lastPeakTime = 0;
    this.cooldownUntil = 0;

    this.baseMinInterval = 180;
    this.cooldownShort = 60;
    this.cooldownMedium = 120;
    this.cooldownLong = 200;

    this.baseVelocityThreshold = 0.0015;
    this.baseZeroThreshold = 0.00025;
    this.adaptiveVelocityThreshold = this.baseVelocityThreshold;
    this.adaptiveZeroThreshold = this.baseZeroThreshold;

    this.emaVelocity = 0;
    this.emaAlpha = 0.15;

    this.currentIntensity = 0;
    this.scaleIndex = 0;

    this.isInBeatWindow = false;
    this.beatWindowStart = 0;
    this.peakVelocityInWindow = 0;

    this.consecutiveBeats = 0;
  }

  update(wrist, timestamp) {
    if (!this.prevWrist || !this.prevTime) {
      this.prevWrist = { ...wrist };
      this.prevTime = timestamp;
      return { beat: false, intensity: this.currentIntensity };
    }

    const dt = timestamp - this.prevTime;
    if (dt === 0 || dt > 100) {
      this.prevWrist = { ...wrist };
      this.prevTime = timestamp;
      return { beat: false, intensity: this.currentIntensity };
    }

    const dx = wrist.x - this.prevWrist.x;
    const dy = wrist.y - this.prevWrist.y;
    const dz = wrist.z - this.prevWrist.z;
    const velocity = Math.sqrt(dx * dx + dy * dy + dz * dz) / (dt / 1000);

    const direction = {
      x: dx > 0 ? 1 : dx < 0 ? -1 : 0,
      y: dy > 0 ? 1 : dy < 0 ? -1 : 0,
      z: dz > 0 ? 1 : dz < 0 ? -1 : 0
    };

    this.velocityHistory.push({ v: velocity, t: timestamp });
    this.directionHistory.push({ dir: direction, t: timestamp });

    const HISTORY_WINDOW = 15;
    if (this.velocityHistory.length > HISTORY_WINDOW) {
      this.velocityHistory.shift();
      this.directionHistory.shift();
    }

    this.emaVelocity = this.emaAlpha * velocity + (1 - this.emaAlpha) * this.emaVelocity;

    const recentVelocities = this.velocityHistory.slice(-8).map(h => h.v);
    const avgRecentVelocity = recentVelocities.reduce((a, b) => a + b, 0) / recentVelocities.length;
    this.currentIntensity = Math.min(1, avgRecentVelocity * 90);

    this.updateAdaptiveThresholds();

    let beat = false;
    let beatIntensity = this.currentIntensity;

    const inCooldown = timestamp < this.cooldownUntil;
    const timeSinceLastBeat = timestamp - this.lastBeatTime;

    if (!inCooldown) {
      const isPeak = this.detectVelocityPeak(velocity, timestamp);
      const directionChanged = this.detectDirectionChange(direction);
      const isDecelerating = velocity < this.prevVelocity * 0.7 && this.prevVelocity > this.adaptiveVelocityThreshold;

      if (isPeak && !this.isInBeatWindow) {
        this.isInBeatWindow = true;
        this.beatWindowStart = timestamp;
        this.peakVelocityInWindow = velocity;
      }

      if (this.isInBeatWindow) {
        this.peakVelocityInWindow = Math.max(this.peakVelocityInWindow, velocity);

        const windowDuration = timestamp - this.beatWindowStart;
        const validWindow = windowDuration >= 40 && windowDuration <= 250;

        if (validWindow && isDecelerating && velocity < this.adaptiveZeroThreshold) {
          const hasSignificantPeak = this.peakVelocityInWindow > this.adaptiveVelocityThreshold * 1.2;
          const minIntervalOk = timeSinceLastBeat > this.getDynamicMinInterval();

          if (hasSignificantPeak && minIntervalOk && (directionChanged || windowDuration > 80)) {
            beat = true;
            this.lastBeatTime = timestamp;
            this.consecutiveBeats++;
            beatIntensity = Math.min(1, this.peakVelocityInWindow * 85);

            if (this.lastBeatTime > 0) {
              this.interbeatIntervals.push(timeSinceLastBeat);
              if (this.interbeatIntervals.length > 10) {
                this.interbeatIntervals.shift();
              }
            }

            const cooldown = this.getDynamicCooldown();
            this.cooldownUntil = timestamp + cooldown;

            this.isInBeatWindow = false;
            this.peakVelocityInWindow = 0;
          }
        }

        if (windowDuration > 300) {
          this.isInBeatWindow = false;
          this.peakVelocityInWindow = 0;
          this.consecutiveBeats = Math.max(0, this.consecutiveBeats - 1);
        }
      }
    }

    if (!beat && timeSinceLastBeat > 800 && this.consecutiveBeats > 0) {
      this.consecutiveBeats = Math.max(0, this.consecutiveBeats - 1);
    }

    this.prevWrist = { ...wrist };
    this.prevTime = timestamp;
    this.prevVelocity = velocity;
    this.prevDirection = direction;

    return { beat, intensity: beatIntensity, velocity };
  }

  updateAdaptiveThresholds() {
    if (this.velocityHistory.length < 6) return;

    const recent = this.velocityHistory.slice(-10);
    const velocities = recent.map(h => h.v);
    const sorted = [...velocities].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    const recentPeaks = this.peakHistory.slice(-5);
    const avgPeak = recentPeaks.length > 0
      ? recentPeaks.reduce((a, b) => a + b, 0) / recentPeaks.length
      : this.baseVelocityThreshold;

    const bpm = this.estimateBPM();
    const bpmFactor = bpm > 120 ? Math.min(1.5, 1 + (bpm - 120) / 200) : 1;

    this.adaptiveVelocityThreshold = Math.max(
      this.baseVelocityThreshold * 0.6,
      Math.min(
        this.baseVelocityThreshold * 2.0,
        (avgPeak * 0.35 + median * 0.65) * bpmFactor
      )
    );

    this.adaptiveZeroThreshold = Math.max(
      this.baseZeroThreshold * 0.5,
      Math.min(
        this.baseZeroThreshold * 1.5,
        this.baseZeroThreshold * bpmFactor
      )
    );
  }

  detectVelocityPeak(velocity, timestamp) {
    const PEAK_WINDOW = 3;
    if (this.velocityHistory.length < PEAK_WINDOW * 2 + 1) return false;

    const recent = this.velocityHistory.slice(-(PEAK_WINDOW * 2 + 1));
    const midIdx = Math.floor(recent.length / 2);
    const midVel = recent[midIdx].v;

    let isLocalMax = true;
    for (let i = 0; i < recent.length; i++) {
      if (i !== midIdx && recent[i].v >= midVel * 0.95) {
        isLocalMax = false;
        break;
      }
    }

    if (isLocalMax && midVel > this.adaptiveVelocityThreshold * 0.8) {
      this.peakHistory.push(midVel);
      this.lastPeakTime = timestamp;
      if (this.peakHistory.length > 20) {
        this.peakHistory.shift();
      }
      return true;
    }
    return false;
  }

  detectDirectionChange(currentDir) {
    if (this.directionHistory.length < 4) return false;

    const recent = this.directionHistory.slice(-4);
    let changes = 0;

    for (let i = 1; i < recent.length; i++) {
      const prev = recent[i - 1].dir;
      const curr = recent[i].dir;
      if (prev.y !== 0 && curr.y !== 0 && prev.y !== curr.y) {
        changes++;
      }
    }

    return changes >= 1;
  }

  estimateBPM() {
    if (this.interbeatIntervals.length < 3) return 60;

    const recent = this.interbeatIntervals.slice(-6);
    const avgInterval = recent.reduce((a, b) => a + b, 0) / recent.length;
    return Math.round(60000 / avgInterval);
  }

  getDynamicMinInterval() {
    const bpm = this.estimateBPM();
    const baseInterval = Math.max(this.baseMinInterval, 60000 / Math.max(bpm + 20, 80));

    if (this.consecutiveBeats >= 4) {
      return baseInterval * 0.85;
    } else if (this.consecutiveBeats >= 2) {
      return baseInterval * 0.92;
    }
    return baseInterval;
  }

  getDynamicCooldown() {
    const bpm = this.estimateBPM();

    if (bpm > 160) {
      return this.cooldownShort;
    } else if (bpm > 120) {
      return this.cooldownMedium;
    } else if (this.consecutiveBeats >= 3) {
      return this.cooldownMedium;
    }
    return this.cooldownLong;
  }

  getNextNote() {
    const freq = this.scale[this.scaleIndex % this.scale.length];
    this.scaleIndex++;
    return freq;
  }
}

class Conductor {
  constructor(ws, section) {
    this.ws = ws;
    this.section = section;
    const scale = section === 'strings' ? C_MAJOR_SCALE_STRINGS : C_MAJOR_SCALE_WIND;
    this.leftDetector = new BeatDetector('left', scale);
    this.rightDetector = new BeatDetector('right', scale);
    this.lastLandmarks = null;
    this.connected = true;
  }

  processFrame(data, timestamp) {
    const result = {
      section: this.section,
      leftBeat: false,
      rightBeat: false,
      leftNote: null,
      rightNote: null,
      leftIntensity: this.leftDetector.currentIntensity,
      rightIntensity: this.rightDetector.currentIntensity,
      leftVelocity: 0,
      rightVelocity: 0,
      landmarks: data
    };

    if (data.leftWrist) {
      const leftResult = this.leftDetector.update(data.leftWrist, timestamp);
      result.leftBeat = leftResult.beat;
      result.leftIntensity = leftResult.intensity;
      result.leftVelocity = leftResult.velocity || 0;

      if (leftResult.beat) {
        const noteFreq = this.leftDetector.getNextNote();
        result.leftNote = noteFreq;
        insertBeat(timestamp, this.room.id, this.section, 'left', leftResult.velocity || 0, leftResult.intensity, Math.round(noteFreq));
      }
    }

    if (data.rightWrist) {
      const rightResult = this.rightDetector.update(data.rightWrist, timestamp);
      result.rightBeat = rightResult.beat;
      result.rightIntensity = rightResult.intensity;
      result.rightVelocity = rightResult.velocity || 0;

      if (rightResult.beat) {
        const noteFreq = this.rightDetector.getNextNote();
        result.rightNote = noteFreq;
        insertBeat(timestamp, this.room.id, this.section, 'right', rightResult.velocity || 0, rightResult.intensity, Math.round(noteFreq));
      }
    }

    this.lastLandmarks = data;
    return result;
  }
}

class Room {
  constructor(id) {
    this.id = id;
    this.stringsConductor = null;
    this.windConductor = null;
    this.createdAt = Date.now();
  }

  addConductor(ws, section) {
    if (section === 'strings' && !this.stringsConductor) {
      this.stringsConductor = new Conductor(ws, 'strings');
      return this.stringsConductor;
    }
    if (section === 'wind' && !this.windConductor) {
      this.windConductor = new Conductor(ws, 'wind');
      return this.windConductor;
    }
    return null;
  }

  removeConductor(section) {
    if (section === 'strings') {
      this.stringsConductor = null;
    } else if (section === 'wind') {
      this.windConductor = null;
    }
  }

  getOtherConductor(section) {
    return section === 'strings' ? this.windConductor : this.stringsConductor;
  }

  isEmpty() {
    return !this.stringsConductor && !this.windConductor;
  }

  isFull() {
    return this.stringsConductor && this.windConductor;
  }

  broadcastToAll(message) {
    if (this.stringsConductor && this.stringsConductor.ws.readyState === WebSocket.OPEN) {
      this.stringsConductor.ws.send(message);
    }
    if (this.windConductor && this.windConductor.ws.readyState === WebSocket.OPEN) {
      this.windConductor.ws.send(message);
    }
  }
}

function getOrCreateRoom(roomId) {
  let room = ROOMS.get(roomId);
  if (!room) {
    room = new Room(roomId);
    ROOMS.set(roomId, room);
    console.log(`Room ${roomId} created`);
  }
  return room;
}

function cleanupEmptyRooms() {
  for (const [id, room] of ROOMS) {
    if (room.isEmpty()) {
      ROOMS.delete(id);
      console.log(`Room ${id} cleaned up`);
    }
  }
}

setInterval(cleanupEmptyRooms, 60000);

function sendToClient(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...data }));
  }
}

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentSection = null;
  let conductor = null;

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      const timestamp = Date.now();

      if (data.type === 'join') {
        const { roomId, section } = data;
        const room = getOrCreateRoom(roomId);

        if (section !== 'strings' && section !== 'wind') {
          sendToClient(ws, 'error', { message: 'Invalid section' });
          return;
        }

        const existing = section === 'strings' ? room.stringsConductor : room.windConductor;
        if (existing) {
          sendToClient(ws, 'error', { message: `${section} section already occupied` });
          return;
        }

        conductor = room.addConductor(ws, section);
        if (!conductor) {
          sendToClient(ws, 'error', { message: 'Failed to join room' });
          return;
        }

        currentRoom = room;
        currentSection = section;

        const partner = room.getOtherConductor(section);

        sendToClient(ws, 'joined', {
          roomId: room.id,
          section,
          partnerConnected: !!partner,
          partnerSection: partner ? (section === 'strings' ? 'wind' : 'strings') : null
        });

        if (partner) {
          sendToClient(partner.ws, 'partnerJoined', {
            section: currentSection
          });
        }

        console.log(`Client joined room ${room.id} as ${section}`);
        return;
      }

      if (data.type === 'frame' && currentRoom && conductor) {
        const result = conductor.processFrame(data, timestamp);

        const myResult = {
          type: 'beatUpdate',
          mySection: currentSection,
          strings: null,
          wind: null
        };

        if (currentSection === 'strings') {
          myResult.strings = result;
          const partner = currentRoom.windConductor;
          if (partner && partner.lastLandmarks) {
            myResult.wind = {
              section: 'wind',
              leftBeat: false,
              rightBeat: false,
              leftIntensity: partner.leftDetector.currentIntensity,
              rightIntensity: partner.rightDetector.currentIntensity,
              leftVelocity: 0,
              rightVelocity: 0,
              landmarks: partner.lastLandmarks
            };
          }
        } else {
          myResult.wind = result;
          const partner = currentRoom.stringsConductor;
          if (partner && partner.lastLandmarks) {
            myResult.strings = {
              section: 'strings',
              leftBeat: false,
              rightBeat: false,
              leftIntensity: partner.leftDetector.currentIntensity,
              rightIntensity: partner.rightDetector.currentIntensity,
              leftVelocity: 0,
              rightVelocity: 0,
              landmarks: partner.lastLandmarks
            };
          }
        }

        const partner = currentRoom.getOtherConductor(currentSection);
        if (partner && partner.ws.readyState === WebSocket.OPEN) {
          const partnerResult = {
            type: 'beatUpdate',
            mySection: partner.section,
            strings: null,
            wind: null
          };

          if (partner.section === 'strings') {
            partnerResult.strings = {
              section: 'strings',
              leftBeat: false,
              rightBeat: false,
              leftIntensity: partner.leftDetector.currentIntensity,
              rightIntensity: partner.rightDetector.currentIntensity,
              leftVelocity: 0,
              rightVelocity: 0,
              landmarks: partner.lastLandmarks
            };
            partnerResult.wind = result;
          } else {
            partnerResult.wind = {
              section: 'wind',
              leftBeat: false,
              rightBeat: false,
              leftIntensity: partner.leftDetector.currentIntensity,
              rightIntensity: partner.rightDetector.currentIntensity,
              leftVelocity: 0,
              rightVelocity: 0,
              landmarks: partner.lastLandmarks
            };
            partnerResult.strings = result;
          }

          partner.ws.send(JSON.stringify(partnerResult));
        }

        ws.send(JSON.stringify(myResult));
      }
    } catch (e) {
      console.error('Error processing message:', e);
    }
  });

  ws.on('close', () => {
    if (currentRoom && currentSection) {
      const partner = currentRoom.getOtherConductor(currentSection);
      if (partner) {
        sendToClient(partner.ws, 'partnerLeft', { section: currentSection });
      }

      currentRoom.removeConductor(currentSection);
      console.log(`Client left room ${currentRoom.id} (${currentSection})`);

      if (currentRoom.isEmpty()) {
        setTimeout(cleanupEmptyRooms, 1000);
      }
    }
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
