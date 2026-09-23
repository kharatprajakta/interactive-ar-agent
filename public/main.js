import * as THREE from 'three';
import { Avatar, VOICE_CHARACTERS, DEFAULT_CHARACTER } from './avatar.js';
import { Voice } from './voice.js';

const els = {
  video: document.getElementById('camera'),
  stage: document.getElementById('stage'),
  ui: document.getElementById('ui'),
  status: document.getElementById('status'),
  hint: document.getElementById('hint'),
  log: document.getElementById('log'),
  composer: document.getElementById('composer'),
  text: document.getElementById('text'),
  mic: document.getElementById('btn-mic'),
  ar: document.getElementById('btn-ar'),
  mute: document.getElementById('btn-mute'),
  voiceSelect: document.getElementById('voice-select'),
  start: document.getElementById('start'),
  startBtn: document.getElementById('btn-start'),
};

const STATUS_LABELS = { idle: 'Idle', listening: 'Listening…', thinking: 'Thinking…', speaking: 'Speaking' };
const AR_SCALE = 1.4; // a bit bigger in the real room
const GREETING = "Hi, I'm Nova! Tap the mic and talk to me, or type a message.";

// ---------------------------------------------------------------------------
// Scene
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
els.stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.01, 30);

scene.add(new THREE.HemisphereLight(0xffffff, 0x8090a8, 1.3));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(1, 2, 1.5);
scene.add(sun);

const avatar = new Avatar();
function showCharacterFor(voiceName) {
  avatar.setCharacter(VOICE_CHARACTERS[voiceName] || DEFAULT_CHARACTER).catch((err) => {
    console.error(err);
    addMessage('system', `Couldn't load the character model: ${err.message}`);
  });
}
showCharacterFor(null);
scene.add(avatar.group);

// Floor reticle shown during AR hit-testing.
const reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.07, 0.09, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

function resetView() {
  // Non-AR view: avatar at the origin, camera framed so the chat panel doesn't cover it.
  avatar.group.position.set(0, 0, 0);
  avatar.group.scale.setScalar(1);
  avatar.group.visible = true;
  camera.position.set(0, 0.5, 1.4);
  camera.lookAt(0, 0.14, 0);
  onResize();
}

function onResize() {
  if (renderer.xr.isPresenting) return;
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
resetView();

// ---------------------------------------------------------------------------
// Camera passthrough (works everywhere, used when WebXR AR isn't available)
// ---------------------------------------------------------------------------
let cameraStream = null;

async function startCamera() {
  if (cameraStream || !navigator.mediaDevices?.getUserMedia) return;
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    els.video.srcObject = cameraStream;
    await els.video.play();
    const facing = cameraStream.getVideoTracks()[0]?.getSettings().facingMode;
    els.video.classList.toggle('mirror', facing !== 'environment');
    document.body.classList.add('has-camera');
  } catch (err) {
    console.warn('Camera unavailable:', err);
    addMessage('system', 'Camera unavailable, so Nova is shown on a plain background.');
  }
}

function stopCamera() {
  cameraStream?.getTracks().forEach((t) => t.stop());
  cameraStream = null;
  els.video.srcObject = null;
  document.body.classList.remove('has-camera');
}

// ---------------------------------------------------------------------------
// WebXR AR (Android Chrome + ARCore): tap the floor to place Nova
// ---------------------------------------------------------------------------
let hitTestSource = null;
let placed = false;

if (navigator.xr?.isSessionSupported) {
  navigator.xr
    .isSessionSupported('immersive-ar')
    .then((ok) => (els.ar.hidden = !ok))
    .catch(() => {});
}

// Taps on the UI shouldn't also count as "place avatar" taps.
for (const el of document.querySelectorAll('.interactive')) {
  el.addEventListener('beforexrselect', (e) => e.preventDefault());
}

const controller = renderer.xr.getController(0);
controller.addEventListener('select', () => {
  if (!reticle.visible) return;
  avatar.group.position.setFromMatrixPosition(reticle.matrix);
  avatar.group.visible = true;
  if (!placed) avatar.wave();
  placed = true;
  showHint(null);
});
scene.add(controller);

async function toggleAR() {
  const current = renderer.xr.getSession();
  if (current) return current.end();

  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test'],
      optionalFeatures: ['dom-overlay'],
      domOverlay: { root: els.ui },
    });
  } catch (err) {
    addMessage('system', `Couldn't start AR: ${err.message}`);
    return;
  }

  stopCamera();
  renderer.xr.setReferenceSpaceType('local');
  await renderer.xr.setSession(session);
  document.body.classList.add('in-ar');
  els.ar.textContent = 'Exit AR';

  placed = false;
  avatar.group.visible = false;
  avatar.group.scale.setScalar(AR_SCALE);
  showHint('Point your phone at the floor, then tap to place Nova.');

  const viewerSpace = await session.requestReferenceSpace('viewer');
  hitTestSource = await session.requestHitTestSource({ space: viewerSpace });

  session.addEventListener('end', () => {
    hitTestSource = null;
    reticle.visible = false;
    document.body.classList.remove('in-ar');
    els.ar.textContent = 'Enter AR';
    showHint(null);
    resetView();
    startCamera();
  });
}

function showHint(text) {
  els.hint.hidden = !text;
  els.hint.textContent = text || '';
}

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------
let lastTime = 0;
renderer.setAnimationLoop((time, frame) => {
  const t = time / 1000;
  const dt = Math.min(0.1, t - lastTime);
  lastTime = t;

  if (frame && hitTestSource) {
    const hits = frame.getHitTestResults(hitTestSource);
    const pose = hits.length ? hits[0].getPose(renderer.xr.getReferenceSpace()) : null;
    reticle.visible = !!pose;
    if (pose) reticle.matrix.fromArray(pose.transform.matrix);
    reticle.material.opacity = placed ? 0.35 : 1;
  }

  // In XR, three.js copies the headset/phone pose into `camera` each frame.
  avatar.update(dt, t, camera.position);
  renderer.render(scene, camera);
});

// ---------------------------------------------------------------------------
// Conversation
// ---------------------------------------------------------------------------
let state = 'idle';
let streaming = false;
let requestId = 0;
let abortController = null;
const history = [];

function setState(next) {
  state = next;
  avatar.setState(next);
  els.status.dataset.state = next;
  els.status.textContent = STATUS_LABELS[next];
}

const voice = new Voice({
  onSpeakingChange(isSpeaking) {
    avatar.speaking = isSpeaking;
    if (isSpeaking) setState('speaking');
    else if (state === 'speaking') setState(streaming ? 'thinking' : 'idle');
  },
  onBoundary: () => avatar.syllable(),
});
avatar.getLevel = () => voice.level;

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  els.log.appendChild(div);
  while (els.log.children.length > 60) els.log.firstChild.remove();
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}

// Speak each finished sentence as soon as it streams in, for low latency.
function speakFinishedSentences(buffer) {
  const re = /[.!?]+["')\]]?(?=\s)|\n+/g;
  let consumed = 0;
  let m;
  while ((m = re.exec(buffer))) {
    const end = m.index + m[0].length;
    voice.speak(buffer.slice(consumed, end));
    consumed = end;
  }
  return buffer.slice(consumed);
}

async function ask(text) {
  text = text.trim();
  if (!text) return;

  // Interrupt whatever Nova was doing.
  abortController?.abort();
  voice.stop();
  const id = ++requestId;
  abortController = new AbortController();

  addMessage('user', text);
  history.push({ role: 'user', content: text });
  setState('thinking');

  const bubble = addMessage('agent', '');
  bubble.classList.add('pending');
  let full = '';
  let unspoken = '';
  streaming = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: history }),
      signal: abortController.signal,
    });
    if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      full += value;
      unspoken = speakFinishedSentences(unspoken + value);
      bubble.textContent = full;
      bubble.classList.remove('pending');
      els.log.scrollTop = els.log.scrollHeight;
    }
    voice.speak(unspoken);
    history.push({ role: 'assistant', content: full });
  } catch (err) {
    if (err.name === 'AbortError') {
      if (full) history.push({ role: 'assistant', content: full });
      else bubble.remove();
      return;
    }
    bubble.classList.remove('pending');
    bubble.classList.add('error');
    bubble.textContent = err.message;
    history.pop(); // drop the unanswered user turn
  } finally {
    if (id === requestId) {
      streaming = false;
      if (!voice.speaking && state !== 'listening') setState('idle');
    }
  }
}

// ---------------------------------------------------------------------------
// Input: text box, mic, mute, AR
// ---------------------------------------------------------------------------
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.text.value;
  els.text.value = '';
  ask(text);
});

els.mic.addEventListener('click', () => {
  if (!voice.canListen) {
    addMessage('system', "Speech recognition isn't supported in this browser. Try Chrome or Edge, or type instead.");
    return;
  }
  if (voice.listening) {
    voice.stopListening();
    return;
  }

  voice.stop(); // let the user barge in
  abortController?.abort();
  setState('listening');
  els.mic.classList.add('active');
  els.text.value = '';

  voice.listen({
    onInterim: (text) => (els.text.value = text),
    onEnd: (text, error) => {
      els.mic.classList.remove('active');
      els.text.value = '';
      if (text) return ask(text);
      setState('idle');
      if (error === 'not-allowed') addMessage('system', 'Microphone access was blocked. Allow it in your browser settings.');
      else if (error && error !== 'no-speech' && error !== 'aborted') addMessage('system', `Mic error: ${error}`);
    },
  });
});

els.mute.addEventListener('click', () => {
  voice.muted = !voice.muted;
  if (voice.muted) voice.stop();
  els.mute.setAttribute('aria-pressed', String(voice.muted));
  els.mute.textContent = voice.muted ? 'Voice off' : 'Voice on';
});

els.ar.addEventListener('click', toggleAR);

els.voiceSelect.addEventListener('change', () => {
  voice.useKitten(els.voiceSelect.value);
  showCharacterFor(els.voiceSelect.value);
  voice.stop();
  voice.speak(`Hi, this is my ${els.voiceSelect.value} voice.`);
});

function setupKittenVoices({ voices, default_voice }) {
  voice.useKitten(default_voice);
  showCharacterFor(default_voice);
  els.voiceSelect.replaceChildren(
    ...voices.map((name) => new Option(name, name, false, name === default_voice)),
  );
  els.voiceSelect.hidden = false;
}

async function checkBackend() {
  try {
    const health = await (await fetch('/api/health')).json();
    if (!health.ok) addMessage('system', health.error);
    if (health.tts?.ok) setupKittenVoices(health.tts);
  } catch {
    addMessage('system', "Can't reach the server.");
  }
}

els.startBtn.addEventListener('click', async () => {
  els.start.hidden = true;
  voice.unlock(); // must run inside the click to unlock audio on mobile
  await Promise.all([startCamera(), checkBackend()]);
  avatar.wave();
  addMessage('agent', GREETING);
  voice.speak(GREETING);
});
