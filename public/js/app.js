const videoElement = document.getElementById('inputVideo');
const canvasElement = document.getElementById('outputCanvas');
const canvasCtx = canvasElement.getContext('2d');
const rippleCanvas = document.getElementById('rippleCanvas');
const rippleCtx = rippleCanvas.getContext('2d');

const leftBeatLight = document.getElementById('leftBeatLight');
const rightBeatLight = document.getElementById('rightBeatLight');
const leftIntensityBar = document.getElementById('leftIntensityBar');
const rightIntensityBar = document.getElementById('rightIntensityBar');
const leftIntensityValue = document.getElementById('leftIntensityValue');
const rightIntensityValue = document.getElementById('rightIntensityValue');
const connectionStatus = document.getElementById('connectionStatus');
const fpsCounter = document.getElementById('fpsCounter');
const beatCountEl = document.getElementById('beatCount');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const volumeSlider = document.getElementById('volumeSlider');

let ws = null;
let hands = null;
let camera = null;
let isRunning = false;
let frameCount = 0;
let lastFpsUpdate = Date.now();
let beatCount = 0;
let audioCtx = null;
let masterGain = null;

const ripples = [];

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseInt(volumeSlider.value) / 100;
  masterGain.connect(audioCtx.destination);
}

function playNote(frequency, intensity) {
  if (!audioCtx || !masterGain) return;

  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(frequency, audioCtx.currentTime);

  const harmonic = audioCtx.createOscillator();
  harmonic.type = 'triangle';
  harmonic.frequency.setValueAtTime(frequency * 2, audioCtx.currentTime);
  const harmonicGain = audioCtx.createGain();
  harmonicGain.gain.value = 0.15;

  const volume = Math.min(0.8, 0.1 + intensity * 0.7);
  const now = audioCtx.currentTime;
  const attack = 0.01;
  const decay = 0.15;
  const sustain = 0.3;
  const release = 0.4;

  gainNode.gain.setValueAtTime(0, now);
  gainNode.gain.linearRampToValueAtTime(volume, now + attack);
  gainNode.gain.linearRampToValueAtTime(volume * sustain, now + attack + decay);
  gainNode.gain.linearRampToValueAtTime(0, now + attack + decay + release);

  harmonicGain.gain.setValueAtTime(0, now);
  harmonicGain.gain.linearRampToValueAtTime(volume * 0.15, now + attack);
  harmonicGain.gain.linearRampToValueAtTime(0, now + attack + decay + release);

  osc.connect(gainNode);
  harmonic.connect(harmonicGain);
  gainNode.connect(masterGain);
  harmonicGain.connect(masterGain);

  osc.start(now);
  harmonic.start(now);
  osc.stop(now + attack + decay + release + 0.1);
  harmonic.stop(now + attack + decay + release + 0.1);
}

volumeSlider.addEventListener('input', () => {
  if (masterGain) {
    masterGain.gain.value = parseInt(volumeSlider.value) / 100;
  }
});

function initWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}`);

  ws.onopen = () => {
    connectionStatus.textContent = '已连接';
    connectionStatus.classList.remove('disconnected');
    connectionStatus.classList.add('connected');
  };

  ws.onclose = () => {
    connectionStatus.textContent = '未连接';
    connectionStatus.classList.remove('connected');
    connectionStatus.classList.add('disconnected');
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };
}

function handleServerMessage(data) {
  if (data.leftBeat) {
    triggerBeat('left', data.leftIntensity);
    if (data.leftNote) {
      playNote(data.leftNote, data.leftIntensity);
      addRipple('left', data.leftIntensity);
    }
  }
  if (data.rightBeat) {
    triggerBeat('right', data.rightIntensity);
    if (data.rightNote) {
      playNote(data.rightNote, data.rightIntensity);
      addRipple('right', data.rightIntensity);
    }
  }

  updateIntensity('left', data.leftIntensity);
  updateIntensity('right', data.rightIntensity);
}

function triggerBeat(hand, intensity) {
  const light = hand === 'left' ? leftBeatLight : rightBeatLight;
  light.classList.add('active');
  beatCount++;
  beatCountEl.textContent = beatCount;
  setTimeout(() => light.classList.remove('active'), 150);
}

function updateIntensity(hand, intensity) {
  const pct = Math.round(intensity * 100);
  if (hand === 'left') {
    leftIntensityBar.style.width = `${pct}%`;
    leftIntensityValue.textContent = `${pct}%`;
  } else {
    rightIntensityBar.style.width = `${pct}%`;
    rightIntensityValue.textContent = `${pct}%`;
  }
}

function addRipple(hand, intensity) {
  const rect = rippleCanvas.getBoundingClientRect();
  ripples.push({
    x: hand === 'left' ? rect.width * 0.25 : rect.width * 0.75,
    y: rect.height / 2,
    radius: 5,
    maxRadius: 30 + intensity * 80,
    opacity: 0.8,
    color: hand === 'left' ? '34, 197, 94' : '59, 130, 246'
  });
}

function drawRipples() {
  const rect = rippleCanvas.getBoundingClientRect();
  rippleCanvas.width = rect.width;
  rippleCanvas.height = rect.height;

  rippleCtx.clearRect(0, 0, rippleCanvas.width, rippleCanvas.height);

  for (let i = ripples.length - 1; i >= 0; i--) {
    const r = ripples[i];
    rippleCtx.beginPath();
    rippleCtx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
    rippleCtx.strokeStyle = `rgba(${r.color}, ${r.opacity})`;
    rippleCtx.lineWidth = 3;
    rippleCtx.stroke();

    r.radius += 3;
    r.opacity -= 0.025;

    if (r.opacity <= 0 || r.radius >= r.maxRadius) {
      ripples.splice(i, 1);
    }
  }

  requestAnimationFrame(drawRipples);
}

function resizeCanvas() {
  const rect = videoElement.getBoundingClientRect();
  canvasElement.width = rect.width;
  canvasElement.height = rect.height;
}

function onResults(results) {
  resizeCanvas();
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

  const frameData = {
    leftWrist: null,
    rightWrist: null
  };

  if (results.multiHandLandmarks && results.multiHandedness) {
    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
      const landmarks = results.multiHandLandmarks[i];
      const handedness = results.multiHandedness[i].label;

      if (window.drawConnectors && window.HAND_CONNECTIONS) {
        window.drawConnectors(canvasCtx, landmarks, window.HAND_CONNECTIONS, {
          color: handedness === 'Left' ? '#22c55e' : '#3b82f6',
          lineWidth: 3
        });
        window.drawLandmarks(canvasCtx, landmarks, {
          color: handedness === 'Left' ? '#4ade80' : '#60a5fa',
          lineWidth: 1,
          radius: 3
        });
      }

      const wrist = landmarks[0];
      if (handedness === 'Left') {
        frameData.leftWrist = { x: wrist.x, y: wrist.y, z: wrist.z };
      } else {
        frameData.rightWrist = { x: wrist.x, y: wrist.y, z: wrist.z };
      }
    }
  }

  canvasCtx.restore();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(frameData));
  }

  frameCount++;
  const now = Date.now();
  if (now - lastFpsUpdate >= 1000) {
    fpsCounter.textContent = frameCount;
    frameCount = 0;
    lastFpsUpdate = now;
  }
}

async function startCapture() {
  initAudio();
  if (audioCtx && audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  initWebSocket();

  hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
  });

  hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.6,
    minTrackingConfidence: 0.5
  });

  hands.onResults(onResults);

  camera = new Camera(videoElement, {
    onFrame: async () => {
      await hands.send({ image: videoElement });
    },
    width: 1280,
    height: 720
  });

  await camera.start();

  isRunning = true;
  startBtn.disabled = true;
  stopBtn.disabled = false;
}

function stopCapture() {
  if (camera) {
    camera.stop();
    camera = null;
  }
  if (hands) {
    hands.close();
    hands = null;
  }
  if (ws) {
    ws.close();
    ws = null;
  }

  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

window.addEventListener('resize', resizeCanvas);
drawRipples();
