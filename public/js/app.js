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
const roomIdDisplay = document.getElementById('roomIdDisplay');
const sectionDisplay = document.getElementById('sectionDisplay');
const partnerStatusEl = document.getElementById('partnerStatus');
const fpsCounter = document.getElementById('fpsCounter');
const beatCountEl = document.getElementById('beatCount');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const volumeSlider = document.getElementById('volumeSlider');

const setupPanel = document.getElementById('setupPanel');
const mainContent = document.getElementById('mainContent');
const joinBtn = document.getElementById('joinBtn');
const roomIdInput = document.getElementById('roomIdInput');
const generateRoomBtn = document.getElementById('generateRoomBtn');
const setupPartnerDot = document.querySelector('#partnerStatus .partner-dot');
const setupPartnerText = document.querySelector('#partnerStatus .partner-text');

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
let currentRoomId = null;
let currentSection = null;
let partnerConnected = false;
let partnerLandmarks = null;

const ripples = [];

const audioEventQueue = [];
const AUDIO_QUEUE_MAX_SIZE = 32;
const AUDIO_MIN_INTERVAL = 60;
const lastAudioPlayTime = { strings: { left: 0, right: 0 }, wind: { left: 0, right: 0 } };

const oscillatorPool = [];
const gainPool = [];
const POOL_MAX_SIZE = 20;

function generateRandomRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

generateRoomBtn.addEventListener('click', () => {
  roomIdInput.value = generateRandomRoomId();
});

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

  for (let i = 0; i < 6; i++) {
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
    try { osc.disconnect(); } catch (e) {}
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
    try { gain.disconnect(); } catch (e) {}
    try { gain.gain.cancelScheduledValues(audioCtx.currentTime); } catch (e) {}
    gain._active = false;
  }
}

function enqueueAudioEvent(frequency, intensity, section, hand) {
  const now = performance.now();

  if (now - lastAudioPlayTime[section][hand] < AUDIO_MIN_INTERVAL) {
    return false;
  }

  while (audioEventQueue.length >= AUDIO_QUEUE_MAX_SIZE) {
    audioEventQueue.shift();
  }

  audioEventQueue.push({
    frequency,
    intensity,
    section,
    hand,
    enqueueTime: now
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

    if (now - lastAudioPlayTime[event.section][event.hand] < AUDIO_MIN_INTERVAL) {
      break;
    }

    const played = playNoteFromPool(event.frequency, event.intensity, event.section, audioNow);
    if (played) {
      lastAudioPlayTime[event.section][event.hand] = now;
    }
    audioEventQueue.shift();
  }
}

function playNoteFromPool(frequency, intensity, section, startTime) {
  const osc1 = acquireOscillator();
  const osc2 = acquireOscillator();
  const osc3 = acquireOscillator();
  const gain1 = acquireGain();
  const gain2 = acquireGain();
  const gain3 = acquireGain();

  if (!osc1 || !gain1) {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseOscillator(osc3);
    releaseGain(gain1);
    releaseGain(gain2);
    releaseGain(gain3);
    return false;
  }

  const baseVolume = Math.min(0.7, 0.06 + intensity * 0.64);
  const attack = 0.008;
  const decay = section === 'strings' ? 0.25 : 0.12;
  const sustain = section === 'strings' ? 0.4 : 0.28;
  const release = section === 'strings' ? 0.6 : 0.35;
  const totalDuration = attack + decay + release + 0.05;

  osc1.type = section === 'strings' ? 'sawtooth' : 'sine';
  osc1.frequency.setValueAtTime(frequency, startTime);

  if (osc2) {
    osc2.type = section === 'strings' ? 'triangle' : 'triangle';
    osc2.frequency.setValueAtTime(frequency * 2, startTime);
  }

  if (osc3 && section === 'strings') {
    osc3.type = 'sine';
    osc3.frequency.setValueAtTime(frequency * 3, startTime);
  }

  gain1.gain.cancelScheduledValues(startTime);
  gain1.gain.setValueAtTime(0, startTime);

  try {
    gain1.gain.linearRampToValueAtTime(baseVolume, startTime + attack);
    gain1.gain.linearRampToValueAtTime(baseVolume * sustain, startTime + attack + decay);
    gain1.gain.linearRampToValueAtTime(0.0001, startTime + attack + decay + release);
  } catch (e) {
    gain1.gain.setValueAtTime(baseVolume, startTime + 0.01);
    gain1.gain.setValueAtTime(0.0001, startTime + totalDuration - 0.01);
  }

  if (osc2 && gain2) {
    gain2.gain.cancelScheduledValues(startTime);
    gain2.gain.setValueAtTime(0, startTime);
    const harmonicVol = baseVolume * (section === 'strings' ? 0.2 : 0.12);
    try {
      gain2.gain.linearRampToValueAtTime(harmonicVol, startTime + attack);
      gain2.gain.linearRampToValueAtTime(0.0001, startTime + attack + decay + release);
    } catch (e) {
      gain2.gain.setValueAtTime(harmonicVol, startTime + 0.01);
      gain2.gain.setValueAtTime(0.0001, startTime + totalDuration - 0.01);
    }
  }

  if (osc3 && gain3 && section === 'strings') {
    gain3.gain.cancelScheduledValues(startTime);
    gain3.gain.setValueAtTime(0, startTime);
    const harmonicVol = baseVolume * 0.08;
    try {
      gain3.gain.linearRampToValueAtTime(harmonicVol, startTime + attack * 2);
      gain3.gain.linearRampToValueAtTime(0.0001, startTime + attack + decay + release);
    } catch (e) {
      gain3.gain.setValueAtTime(harmonicVol, startTime + 0.02);
      gain3.gain.setValueAtTime(0.0001, startTime + totalDuration - 0.01);
    }
  }

  osc1.connect(gain1);
  gain1.connect(masterGain);

  if (osc2 && gain2) {
    osc2.connect(gain2);
    gain2.connect(masterGain);
  }

  if (osc3 && gain3 && section === 'strings') {
    osc3.connect(gain3);
    gain3.connect(masterGain);
  }

  try {
    osc1.start(startTime);
    if (osc2) osc2.start(startTime);
    if (osc3 && section === 'strings') osc3.start(startTime);
  } catch (e) {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseOscillator(osc3);
    releaseGain(gain1);
    releaseGain(gain2);
    releaseGain(gain3);
    return false;
  }

  const stopTime = startTime + totalDuration;
  osc1.stop(stopTime);
  if (osc2) osc2.stop(stopTime);
  if (osc3 && section === 'strings') osc3.stop(stopTime);

  setTimeout(() => {
    releaseOscillator(osc1);
    releaseOscillator(osc2);
    releaseOscillator(osc3);
    releaseGain(gain1);
    releaseGain(gain2);
    releaseGain(gain3);
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

function playNote(frequency, intensity, section, hand) {
  if (!audioCtx || !masterGain) return;
  enqueueAudioEvent(frequency, intensity, section, hand || 'left');
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
    joinRoom();
  };

  ws.onclose = () => {
    updatePartnerStatus(false);
  };

  ws.onerror = (e) => {
    console.error('WebSocket error:', e);
  };

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    handleServerMessage(data);
  };
}

function joinRoom() {
  if (ws && ws.readyState === WebSocket.OPEN && currentRoomId && currentSection) {
    ws.send(JSON.stringify({
      type: 'join',
      roomId: currentRoomId,
      section: currentSection
    }));
  }
}

function handleServerMessage(data) {
  if (data.type === 'joined') {
    setupPanel.style.display = 'none';
    mainContent.style.display = 'grid';

    roomIdDisplay.textContent = data.roomId;
    sectionDisplay.textContent = data.section === 'strings' ? '🎻 弦乐组' : '🎺 管乐组';
    sectionDisplay.className = 'status-value section-badge ' + data.section;

    updatePartnerStatus(data.partnerConnected);
    startCapture();
    return;
  }

  if (data.type === 'partnerJoined') {
    updatePartnerStatus(true);
    return;
  }

  if (data.type === 'partnerLeft') {
    updatePartnerStatus(false);
    partnerLandmarks = null;
    return;
  }

  if (data.type === 'error') {
    alert(data.message);
    return;
  }

  if (data.type === 'beatUpdate') {
    const myData = data[currentSection];
    const partnerSection = currentSection === 'strings' ? 'wind' : 'strings';
    const partnerData = data[partnerSection];

    if (myData) {
      if (myData.leftBeat) {
        triggerBeat('left', myData.leftIntensity);
        if (myData.leftNote) {
          playNote(myData.leftNote, myData.leftIntensity, currentSection, 'left');
          addRipple('left', myData.leftIntensity, currentSection);
        }
      }
      if (myData.rightBeat) {
        triggerBeat('right', myData.rightIntensity);
        if (myData.rightNote) {
          playNote(myData.rightNote, myData.rightIntensity, currentSection, 'right');
          addRipple('right', myData.rightIntensity, currentSection);
        }
      }

      updateIntensity('left', myData.leftIntensity);
      updateIntensity('right', myData.rightIntensity);
    }

    if (partnerData && partnerData.landmarks) {
      partnerLandmarks = partnerData.landmarks;
    } else {
      partnerLandmarks = null;
    }
  }
}

function updatePartnerStatus(connected) {
  partnerConnected = connected;

  if (partnerStatusEl) {
    if (connected) {
      partnerStatusEl.textContent = '已连接';
      partnerStatusEl.className = 'status-value connected';
    } else {
      partnerStatusEl.textContent = '未连接';
      partnerStatusEl.className = 'status-value disconnected';
    }
  }

  if (setupPartnerDot && setupPartnerText) {
    if (connected) {
      setupPartnerDot.className = 'partner-dot connected';
      setupPartnerText.textContent = '合作伙伴已加入！';
      setupPartnerText.className = 'partner-text connected';
    } else {
      setupPartnerDot.className = 'partner-dot';
      setupPartnerText.textContent = '等待对方加入...';
      setupPartnerText.className = 'partner-text';
    }
  }
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

function addRipple(hand, intensity, section) {
  const rect = rippleCanvas.getBoundingClientRect();
  const color = section === 'strings' ? '168, 85, 247' : '59, 130, 246';
  ripples.push({
    x: hand === 'left' ? rect.width * 0.25 : rect.width * 0.75,
    y: rect.height / 2,
    radius: 5,
    maxRadius: 30 + intensity * 80,
    opacity: 0.8,
    color
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

function drawHandLandmarks(landmarks, handedness, isPartner) {
  if (!window.drawConnectors || !window.HAND_CONNECTIONS || !landmarks) return;

  const landmarksArray = isPartner ? partnerLandmarksToLandmarkArray(landmarks) : landmarks;
  if (!landmarksArray || landmarksArray.length < 21) return;

  let color, lineWidth;
  if (isPartner) {
    color = currentSection === 'strings' ? 'rgba(59, 130, 246, 0.5)' : 'rgba(168, 85, 247, 0.5)';
    lineWidth = 2;
  } else {
    color = handedness === 'Left'
      ? (currentSection === 'strings' ? '#a855f7' : '#3b82f6')
      : '#22c55e';
    lineWidth = 3;
  }

  const scale = handedness === 'Right' && isPartner ? -1 : 1;
  const offsetX = isPartner ? 0.02 : 0;

  const adjustedLandmarks = landmarksArray.map(lm => ({
    x: (lm.x + offsetX) * scale * 0.5 + (isPartner ? 0.5 : 0),
    y: lm.y,
    z: lm.z
  }));

  window.drawConnectors(canvasCtx, adjustedLandmarks, window.HAND_CONNECTIONS, {
    color,
    lineWidth
  });
  window.drawLandmarks(canvasCtx, adjustedLandmarks, {
    color,
    lineWidth: 1,
    radius: isPartner ? 2 : 3
  });
}

function partnerLandmarksToLandmarkArray(data) {
  if (!data) return null;
  return data.landmarks || null;
}

function onResults(results) {
  resizeCanvas();
  canvasCtx.save();
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  canvasCtx.drawImage(results.image, 0, 0, canvasElement.width, canvasElement.height);

  const frameData = {
    leftWrist: null,
    rightWrist: null,
    landmarks: null
  };

  if (results.multiHandLandmarks && results.multiHandedness) {
    const allLandmarks = [];

    for (let i = 0; i < results.multiHandLandmarks.length; i++) {
      const landmarks = results.multiHandLandmarks[i];
      const handedness = results.multiHandedness[i].label;
      allLandmarks.push({ landmarks, handedness });

      const wrist = landmarks[0];
      if (handedness === 'Left') {
        frameData.leftWrist = { x: wrist.x, y: wrist.y, z: wrist.z };
      } else {
        frameData.rightWrist = { x: wrist.x, y: wrist.y, z: wrist.z };
      }

      drawHandLandmarks(landmarks, handedness, false);
    }

    frameData.landmarks = allLandmarks;
  }

  canvasCtx.restore();

  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({
      type: 'frame',
      ...frameData
    }));
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
  lastAudioPlayTime.strings.left = 0;
  lastAudioPlayTime.strings.right = 0;
  lastAudioPlayTime.wind.left = 0;
  lastAudioPlayTime.wind.right = 0;

  partnerLandmarks = null;
  canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
  isRunning = false;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

joinBtn.addEventListener('click', () => {
  const roomId = roomIdInput.value.trim().toUpperCase();
  const section = document.querySelector('input[name="section"]:checked').value;

  if (!roomId) {
    alert('请输入房间号');
    return;
  }

  currentRoomId = roomId;
  currentSection = section;
  initWebSocket();
});

startBtn.addEventListener('click', startCapture);
stopBtn.addEventListener('click', stopCapture);

window.addEventListener('resize', resizeCanvas);
drawRipples();
