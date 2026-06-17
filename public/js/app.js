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
let audioRenderLoopId = null;

const ripples = [];

const audioEventQueue = [];
const AUDIO_QUEUE_MAX_SIZE = 32;
const AUDIO_MIN_INTERVAL = 60;
const lastAudioPlayTime = { left: 0, right: 0 };

const oscillatorPool = [];
const gainPool = [];
const POOL_MAX_SIZE = 16;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  masterGain = audioCtx.createGain();
  masterGain.gain.value = parseInt(volumeSlider.value) / 100;

  const compressor = audioCtx.createDynamicsCompressor();
  compressor.threshold.value = -24;
  compressor.knee.value = 30;
  compressor.ratio.value = 12;
  compressor.attack.value = 0.003;
  compressor.release.value = 0.25;

  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.05;

  masterGain.connect(compressor);
  compressor.connect(limiter);
  limiter.connect(audioCtx.destination);

  for (let i = 0; i < 4; i++) {
    oscillatorPool.push(createPooledOscillator());
    gainPool.push(audioCtx.createGain());
  }

  startAudioRenderLoop();
}

function createPooledOscillator() {
  const osc = audioCtx.createOscillator();
  osc._pooled = true;
  osc._active = false;
  return osc;
}

function acquireOscillator() {
  for (let i = 0; i < oscillatorPool.length; i++) {
    if (!oscillatorPool[i]._active) {
      oscillatorPool[i]._active = true;
      return oscillatorPool[i];
    }
  }
  if (oscillatorPool.length < POOL_MAX_SIZE) {
    const osc = createPooledOscillator();
    osc._active = true;
    oscillatorPool.push(osc);
    return osc;
  }
  return null;
}

function releaseOscillator(osc) {
  if (osc && osc._pooled) {
    osc.disconnect();
    osc._active = false;
  }
}

function acquireGain() {
  for (let i = 0; i < gainPool.length; i++) {
    if (!gainPool[i]._active) {
      gainPool[i]._active = true;
      return gainPool[i];
    }
  }
  if (gainPool.length < POOL_MAX_SIZE) {
    const gain = audioCtx.createGain();
    gain._active = true;
    gainPool.push(gain);
    return gain;
  }
  return null;
}

function releaseGain(gain) {
  if (gain && gain._active) {
    gain.disconnect();
    gain.gain.cancelScheduledValues(audioCtx.currentTime);
    gain._active = false;
  }
}

function enqueueAudioEvent(frequency, intensity, hand) {
  const now = performance.now();

  if (now - lastAudioPlayTime[hand] < AUDIO_MIN_INTERVAL) {
    return false;
  }

  while (audioEventQueue.length >= AUDIO_QUEUE_MAX_SIZE) {
    audioEventQueue.shift();
  }

  audioEventQueue.push({
    frequency,
    intensity,
    hand,
    enqueueTime: now,
    scheduled: false
  });

  return true;
}

function processAudioQueue() {
  if (!audioCtx || !masterGain) return;

  const now = performance.now();
  const audioNow = audioCtx.currentTime;

  while (audioEventQueue.length > 0) {
    const event = audioEventQueue[0];

    if (now - event.enqueueTime > 500) {
      audioEventQueue.shift();
      continue;
    }

    if (now - lastAudioPlayTime[event.hand] < AUDIO_MIN_INTERVAL) {
      break;
    }

    const played = playNoteFromPool(event.frequency, event.intensity, audioNow);
    if (played) {
      lastAudioPlayTime[event.hand] = now;
      event.scheduled = true;
    }
    audioEventQueue.shift();
  }
}

function playNoteFromPool(frequency, intensity, startTime) {
  const osc1 = acquireOscillator();
  const osc2 = acquireOscillator();
  const gain1 = acquireGain();
  const gain2 = acquireGain();

  if (!osc1 || !osc2 || !gain1 || !gain2) {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseGain(gain1);
    releaseGain(gain2);
    return false;
  }

  const volume = Math.min(0.75, 0.08 + intensity * 0.67);
  const attack = 0.008;
  const decay = 0.12;
  const sustain = 0.28;
  const release = 0.35;
  const totalDuration = attack + decay + release + 0.05;

  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(frequency, startTime);

  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(frequency * 2, startTime);

  gain1.gain.cancelScheduledValues(startTime);
  gain1.gain.setValueAtTime(0, startTime);

  try {
    gain1.gain.linearRampToValueAtTime(volume, startTime + attack);
    gain1.gain.linearRampToValueAtTime(volume * sustain, startTime + attack + decay);
    gain1.gain.linearRampToValueAtTime(0.0001, startTime + attack + decay + release);
  } catch (e) {
    gain1.gain.setValueAtTime(volume, startTime + 0.01);
    gain1.gain.setValueAtTime(0.0001, startTime + totalDuration - 0.01);
  }

  gain2.gain.cancelScheduledValues(startTime);
  gain2.gain.setValueAtTime(0, startTime);

  const harmonicVolume = volume * 0.12;
  try {
    gain2.gain.linearRampToValueAtTime(harmonicVolume, startTime + attack);
    gain2.gain.linearRampToValueAtTime(0.0001, startTime + attack + decay + release);
  } catch (e) {
    gain2.gain.setValueAtTime(harmonicVolume, startTime + 0.01);
    gain2.gain.setValueAtTime(0.0001, startTime + totalDuration - 0.01);
  }

  osc1.connect(gain1);
  osc2.connect(gain2);
  gain1.connect(masterGain);
  gain2.connect(masterGain);

  try {
    osc1.start(startTime);
    osc2.start(startTime);
  } catch (e) {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseGain(gain1);
    releaseGain(gain2);
    return false;
  }

  const stopTime = startTime + totalDuration;
  osc1.stop(stopTime);
  osc2.stop(stopTime);

  setTimeout(() => {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseGain(gain1);
    releaseGain(gain2);
  }, totalDuration * 1000 + 50);

  return true;
}

function startAudioRenderLoop() {
  if (audioRenderLoopId) return;

  const render = () => {
    processAudioQueue();
    audioRenderLoopId = requestAnimationFrame(render);
  };

  audioRenderLoopId = requestAnimationFrame(render);
}

function stopAudioRenderLoop() {
  if (audioRenderLoopId) {
    cancelAnimationFrame(audioRenderLoopId);
    audioRenderLoopId = null;
  }
}

function playNote(frequency, intensity, hand) {
  if (!audioCtx || !masterGain) return;
  enqueueAudioEvent(frequency, intensity, hand || 'left');
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
      playNote(data.leftNote, data.leftIntensity, 'left');
      addRipple('left', data.leftIntensity);
    }
  }
  if (data.rightBeat) {
    triggerBeat('right', data.rightIntensity);
    if (data.rightNote) {
      playNote(data.rightNote, data.rightIntensity, 'right');
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

  stopAudioRenderLoop();

  audioEventQueue.length = 0;
  lastAudioPlayTime.left = 0;
  lastAudioPlayTime.right = 0;

  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

window.addEventListener('resize', resizeCanvas);
drawRipples();
