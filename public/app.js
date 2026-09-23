import { Stage, renderPortraits } from './stage.js';
import { Voice, Listener, LocalListener } from './voice.js';
import { sessionId, uploadFile, addLink, listDocs, removeDoc } from './docs.js';

const $ = (id) => document.getElementById(id);
const PHONE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1l-2.2 2.2Z"/></svg>';

let personas = [];
let health = null;
let portraits = {};
let stage = null;
let call = null; // the active call's state

// ===========================================================================
// Voice: speaking and hands-free listening
// ===========================================================================
const voice = new Voice({
  onSpeakingChange(isSpeaking) {
    if (!call) return;
    stage.avatar.speaking = isSpeaking;
    clearTimeout(call.resumeTimer);
    if (isSpeaking) {
      // Don't listen while talking, or the mic hears the agent's own voice
      // through the speakers and it ends up replying to itself.
      listener.pause();
      setState('speaking');
    } else {
      call.lastSpokeAt = performance.now();
      resumeListening(ECHO_TAIL_MS);
      if (call.state === 'speaking') setState(call.streaming ? 'thinking' : 'idle');
      clearTimeout(call.capTimer);
      call.capTimer = setTimeout(() => !voice.speaking && setCaption('agent', ''), 1800);
    }
  },
  onBoundary: () => stage?.avatar.syllable(),
  onSentence(text) {
    if (!call) return;
    setCaption('agent', text);
    call.spoken.push({ text, at: performance.now() });
    if (call.spoken.length > 12) call.spoken.shift();
  },
});

const words = (t) => t.toLowerCase().match(/[\p{L}\p{N}']+/gu) || [];
const ECHO_TAIL_MS = 700; // room echo / speaker lag after the agent stops

/** Reopen the mic after the agent has been quiet for `delay` ms. */
function resumeListening(delay) {
  clearTimeout(call.resumeTimer);
  call.resumeTimer = setTimeout(() => {
    if (call && call.micOn && !voice.speaking) listener.resume();
  }, delay);
}

/**
 * Safety net for speaker echo right after the agent stops (the mic is paused
 * while it talks). Deliberately strict: a real answer often reuses the
 * question's words ("Which class?" / "I'm in class 10"), so only a near-copy
 * of what the agent just said, heard moments after it finished, counts.
 */
function isEcho(text) {
  if (!call || performance.now() - (call.lastSpokeAt || 0) > 1500) return false;
  const recent = call.spoken.filter((s) => performance.now() - s.at < 15000);
  const said = new Set(recent.flatMap((s) => words(s.text)));
  const heard = words(text);
  if (heard.length < 3) return false;
  return heard.filter((w) => said.has(w)).length / heard.length >= 0.8;
}

/** Leave "Hearing you…" if the user trails off without a sendable sentence. */
function armListeningWatchdog() {
  clearTimeout(call.listenTimer);
  call.listenTimer = setTimeout(() => {
    if (call?.state === 'listening') {
      setState('idle');
      setCaption('user', '');
    }
  }, 6000);
}

// Two ways to hear the user (same interface). On-device (Silero VAD + our
// Whisper) is preferred; the browser's Web Speech API is the fallback.
const hearing = {
  onInterim(text) {
    if (!call || !call.micOn) return;
    if (voice.speaking || isEcho(text)) return;
    setCaption('user', text);
    $('btn-mic').classList.add('hearing');
    if (call.state === 'idle') setState('listening');
    armListeningWatchdog();
  },
  onUtterance(text) {
    if (!call || !call.micOn) return;
    $('btn-mic').classList.remove('hearing');
    clearTimeout(call.listenTimer);
    if (!text || voice.speaking || isEcho(text)) {
      if (call.state === 'listening') setState('idle');
      setCaption('user', '');
      return;
    }
    ask(text);
  },
  onError(code) {
    if (!call) return;
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      setMic(false);
      addMsg('system', 'Microphone access was blocked. Allow it in the browser, or type in the chat.');
      openDrawer(true);
    } else if (code === 'network' && listener === webListener && localAvailable()) {
      // The browser's cloud recogniser is unreachable: switch to on-device.
      switchListener(localListener, 'Switched to on-device speech recognition.');
    } else if (code === 'network') {
      setMic(false);
      addMsg('system', "Your browser's speech recognition can't reach its online service (this happens in Brave, Opera, some embedded browsers, or on restricted networks). Start the Python voice service for on-device recognition, or type here.");
      openDrawer(true);
    } else if (code === 'local-failed' && Listener.supported) {
      switchListener(webListener, "On-device speech recognition couldn't start, so using the browser's instead.");
    } else if (code === 'local-failed') {
      setMic(false);
      addMsg('system', "Couldn't start the microphone. Type here instead.");
      openDrawer(true);
    }
  },
};
const webListener = new Listener(hearing);
const localListener = new LocalListener(hearing);
let listener = webListener;

const localAvailable = () => LocalListener.supported && !!health?.tts?.stt;
const canListen = () => localAvailable() || Listener.supported;

function switchListener(next, note) {
  listener.stop();
  listener = next;
  if (note) addMsg('system', note);
  if (call?.micOn) {
    listener.start();
    if (voice.speaking) listener.pause();
  }
}

// ===========================================================================
// Landing page
// ===========================================================================
async function init() {
  const [p, h] = await Promise.all([
    fetch('/api/personas').then((r) => r.json()),
    fetch('/api/health').then((r) => r.json()).catch(() => null),
  ]);
  personas = p.personas;
  health = h;
  renderContacts();
  showNotices();
  portraits = await renderPortraits(personas);
  for (const persona of personas) {
    const art = document.querySelector(`[data-id="${persona.id}"] .card-art`);
    if (art && portraits[persona.id]) art.innerHTML = `<img src="${portraits[persona.id]}" alt="" />`;
  }
}

function renderContacts() {
  const list = $('contacts');
  list.replaceChildren(
    ...personas.map((p) => {
      const li = document.createElement('li');
      li.className = 'card';
      li.dataset.id = p.id;
      li.style.setProperty('--accent', p.color);
      li.innerHTML = `
        <div class="card-art"><div class="skeleton"></div></div>
        <div class="card-body">
          <div class="card-name"></div>
          <div class="card-role"></div>
          <p class="card-tag"></p>
          <button class="call-btn">${PHONE_ICON}<span></span></button>
        </div>`;
      li.querySelector('.card-name').textContent = p.name;
      li.querySelector('.card-role').textContent = p.role;
      li.querySelector('.card-tag').textContent = p.tagline;
      li.querySelector('.call-btn span').textContent = `Call ${p.name}`;
      li.querySelector('.call-btn').addEventListener('click', () => startCall(p));
      return li;
    }),
  );
}

function showNotices() {
  const notes = [];
  if (!health) notes.push("Can't reach the server.");
  else {
    if (health.error) notes.push(health.error);
    if (health.warning) notes.push(health.warning);
    if (!health.tts?.ok) notes.push("The Python voice service isn't running, so calls use your browser's built-in voice.");
    if (health.ncert?.ok && !health.ncert.chunks) notes.push('No NCERT textbooks are loaded yet, so Kiki can\'t teach from them. See the README ("NCERT textbooks").');
  }
  if (!canListen()) notes.push("This browser can't do hands-free voice. Use Chrome or Edge, or start the Python voice service for on-device recognition. You can always type in the call's chat.");
  else if (!localAvailable()) notes.push("Hands-free voice is using your browser's online speech service. Start the Python voice service for private, on-device recognition.");
  $('notice').hidden = !notes.length;
  $('notice').innerHTML = notes.map((n) => `<div>${n.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c])}</div>`).join('');
}

// ===========================================================================
// Call lifecycle
// ===========================================================================
function historyKey(p) {
  return `history:${p.id}`;
}

function loadHistory(p) {
  try {
    return JSON.parse(localStorage.getItem(historyKey(p))) || [];
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    localStorage.setItem(historyKey(call.persona), JSON.stringify(call.history.slice(-30)));
  } catch {}
}

async function startCall(p) {
  if (call) return;
  voice.unlock(); // inside the click, so audio is allowed later

  call = {
    persona: p,
    history: loadHistory(p),
    state: 'idle',
    micOn: canListen(),
    spoken: [],
    streaming: false,
    requestId: 0,
    abort: null,
    cancelled: false,
  };

  const root = $('call');
  root.style.setProperty('--accent', p.color);
  $('home').hidden = true;
  root.hidden = false;
  $('call-name').textContent = p.name;
  $('call-role').textContent = p.role;
  $('call-timer').textContent = '0:00';
  $('log').replaceChildren();
  setCaption('agent', '');
  setCaption('user', '');
  $('study-chip').hidden = true;
  $('hint').hidden = true;
  $('drawer').hidden = true;
  $('btn-chat').setAttribute('aria-pressed', 'false');
  setStatus('Connecting…', 'idle');

  const ringing = $('ringing');
  ringing.classList.remove('gone');
  ringing.hidden = false;
  $('ring-img').src = portraits[p.id] || '';
  $('ring-name').textContent = p.name;
  $('ring-text').textContent = 'Calling…';

  stage ??= new Stage($('stage'));
  stage.avatar.getLevel = () => voice.level;
  stage.start();
  Stage.arSupported().then((ok) => ($('btn-ar').hidden = !ok));

  try {
    // Re-check services too: speech recognition may have finished loading since the page opened.
    const [, , fresh] = await Promise.all([
      stage.load(p),
      new Promise((r) => setTimeout(r, 1400)),
      fetch('/api/health').then((r) => r.json()).catch(() => null),
    ]);
    if (fresh) health = fresh;
  } catch (err) {
    console.error(err);
    $('ring-text').textContent = `Couldn't connect: ${err.message}`;
    return;
  }
  if (!call || call.cancelled || call.persona !== p) return;

  // Connected.
  ringing.classList.add('gone');
  setTimeout(() => (ringing.hidden = true), 500);
  call.startedAt = Date.now();
  call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - call.startedAt) / 1000);
    $('call-timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
  voice.setPersonaVoice(p, !!health?.tts?.ok);
  refreshDocs();

  stage.avatar.wave();
  const greeting = call.history.length ? `Hey, you're back! ${p.greeting.replace(/^[^!.?]*[!.?]\s*/, '')}` : p.greeting;
  addMsg('agent', greeting);
  call.history.push({ role: 'assistant', content: greeting });
  voice.speak(greeting);
  if (!voice.speaking) setState('idle');

  listener = localAvailable() ? localListener : webListener;
  setMic(call.micOn);
  if (!canListen()) {
    addMsg('system', "Hands-free voice isn't supported in this browser, so type here instead.");
    openDrawer(true);
  }
}

function endCall() {
  if (!call) return;
  call.cancelled = true;
  listener.stop();
  voice.stop();
  call.abort?.abort();
  clearInterval(call.timer);
  clearTimeout(call.capTimer);
  clearTimeout(call.resumeTimer);
  clearTimeout(call.listenTimer);
  if (call.history.length) saveHistory();
  setCamera(false);
  stage?.exitAR();
  stage?.stop();
  call = null;
  $('call').hidden = true;
  $('home').hidden = false;
}

// ===========================================================================
// Conversation
// ===========================================================================
const STATUS = { idle: 'Listening', listening: 'Hearing you…', thinking: 'Thinking…', speaking: 'Speaking · tap to interrupt' };

function setStatus(text, state) {
  $('call-status').textContent = text;
  $('call-status').dataset.state = state;
}

function setState(next) {
  if (!call) return;
  call.state = next;
  stage.setMode(next);
  if (next === 'idle' && !call.micOn) setStatus(canListen() ? 'Mic muted' : 'Type to chat', 'muted');
  else if (next !== 'thinking' || !call.statusText) setStatus(STATUS[next], next);
}

function setCaption(who, text) {
  const el = $(who === 'agent' ? 'cap-agent' : 'cap-user');
  el.textContent = text;
  el.classList.remove('status');
  if (who === 'user') {
    clearTimeout(call?.userCapTimer);
    if (text && call) call.userCapTimer = setTimeout(() => ($('cap-user').textContent = ''), 4000);
  }
}

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;
  $('log').appendChild(div);
  $('log').scrollTop = $('log').scrollHeight;
  return div;
}

function showSources(bubble, items) {
  const box = document.createElement('div');
  box.className = 'sources';
  for (const s of items) {
    const el = document.createElement(s.url ? 'a' : 'span');
    el.textContent = s.url ? new URL(s.url).hostname.replace(/^www\./, '') : s.title;
    el.title = s.title;
    if (s.url) Object.assign(el, { href: s.url, target: '_blank', rel: 'noopener' });
    box.appendChild(el);
  }
  bubble.appendChild(box);
}

function interrupt() {
  if (!call) return;
  call.abort?.abort();
  voice.stop();
  call.streaming = false;
  setCaption('agent', '');
  setState('idle');
  resumeListening(250); // the user wants to talk now
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
  if (!text || !call) return;
  const c = call;

  c.abort?.abort();
  voice.stop();
  const id = ++c.requestId;
  const abort = (c.abort = new AbortController());

  addMsg('user', text);
  setCaption('user', text);
  setCaption('agent', '');
  c.history.push({ role: 'user', content: text });
  c.statusText = null;
  c.streaming = true;
  setState('thinking');

  const bubble = addMsg('agent', '…');
  let full = '';
  let unspoken = '';
  let sources = null;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: c.persona.id, session: sessionId(), messages: c.history.slice(-20) }),
      signal: abort.signal,
    });
    if (!res.ok) throw new Error((await res.text()) || `Request failed (${res.status})`);

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === 'text') {
          full += ev.text;
          bubble.textContent = full;
          unspoken = speakFinishedSentences(unspoken + ev.text);
          $('log').scrollTop = $('log').scrollHeight;
        } else if (ev.type === 'status') {
          c.statusText = ev.text;
          setStatus(ev.text, 'thinking');
          $('cap-agent').textContent = ev.text;
          $('cap-agent').classList.add('status');
        } else if (ev.type === 'activity') {
          stage.activity(ev.kind);
        } else if (ev.type === 'sources') {
          sources = ev.items;
        } else if (ev.type === 'doc') {
          refreshDocs();
          addMsg('system', `Added “${ev.doc.title}” to shared documents.`);
        } else if (ev.type === 'study') {
          const chip = $('study-chip');
          chip.textContent = `Class ${ev.class_num} · ${ev.subject}${ev.chapter ? ` · Ch ${ev.chapter}: ${ev.chapter_title}` : ''}`;
          chip.hidden = false;
        } else if (ev.type === 'error') {
          throw new Error(ev.text);
        }
      }
    }
    voice.speak(unspoken);
    if (!full.trim()) throw new Error('No reply came back.');
    if (sources?.length) showSources(bubble, sources);
    c.history.push({ role: 'assistant', content: full });
    saveHistory();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (full) c.history.push({ role: 'assistant', content: full + '…' });
      else bubble.remove();
      return;
    }
    bubble.classList.add('error');
    bubble.textContent = err.message;
    c.history.pop(); // drop the unanswered user turn
  } finally {
    if (call === c && id === c.requestId) {
      c.streaming = false;
      c.statusText = null;
      if (!voice.speaking && c.state !== 'listening') setState('idle');
    }
  }
}

// ===========================================================================
// Controls
// ===========================================================================
function setMic(on) {
  if (!call) return;
  call.micOn = on && canListen();
  $('btn-mic').setAttribute('aria-pressed', String(call.micOn));
  $('btn-mic').classList.remove('hearing');
  if (call.micOn) {
    listener.start();
    if (voice.speaking) listener.pause(); // resumes when the agent finishes
  } else listener.stop();
  if (call.state === 'idle' || call.state === 'listening') setState('idle');
}

async function setCamera(on) {
  const video = $('selfview');
  if (!on) {
    video.srcObject?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    video.hidden = true;
    $('btn-cam').setAttribute('aria-pressed', 'false');
    return;
  }
  try {
    video.srcObject = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 } }, audio: false });
    video.hidden = false;
    await video.play();
    $('btn-cam').setAttribute('aria-pressed', 'true');
  } catch {
    addMsg('system', 'Camera unavailable.');
  }
}

function openDrawer(open) {
  $('drawer').hidden = !open;
  $('btn-chat').setAttribute('aria-pressed', String(open));
  if (open) {
    $('log').scrollTop = $('log').scrollHeight;
    if (!matchMedia('(pointer: coarse)').matches) $('text').focus();
  }
}

async function refreshDocs() {
  const docs = await listDocs().catch(() => []);
  const box = $('docs');
  box.hidden = !docs.length;
  $('doc-count').hidden = !docs.length;
  $('doc-count').textContent = docs.length;
  box.replaceChildren(
    ...docs.map((d) => {
      const chip = document.createElement('span');
      chip.className = 'doc';
      chip.title = d.source || d.title;
      chip.innerHTML = `<span></span><button aria-label="Remove">✕</button>`;
      chip.firstChild.textContent = `${d.type === 'link' ? '🔗' : '📄'} ${d.title}`;
      chip.querySelector('button').addEventListener('click', async () => {
        await removeDoc(d.id);
        refreshDocs();
      });
      return chip;
    }),
  );
}

async function shareThen(label, work) {
  const note = addMsg('system', label);
  try {
    const doc = await work((msg) => (note.textContent = msg));
    note.textContent = `Shared “${doc.title}”.`;
    refreshDocs();
    ask(`I've shared “${doc.title}” with you. Can you give me a quick overview of what it covers?`);
  } catch (err) {
    note.textContent = err.message;
    note.classList.add('error');
  }
}

$('btn-mic').addEventListener('click', () => setMic(!call?.micOn));
// Tap the scene (or the status pill) to cut the agent off, like interrupting on a call.
for (const id of ['stage', 'call-status']) {
  $(id).addEventListener('click', () => call && (voice.speaking || call.streaming) && interrupt());
}
$('btn-cam').addEventListener('click', () => setCamera($('selfview').hidden));
$('btn-chat').addEventListener('click', () => openDrawer($('drawer').hidden));
$('btn-drawer-close').addEventListener('click', () => openDrawer(false));
$('btn-end').addEventListener('click', endCall);
$('btn-cancel').addEventListener('click', endCall);
$('btn-attach').addEventListener('click', () => $('file-input').click());
$('btn-link').addEventListener('click', () => {
  $('link-form').hidden = !$('link-form').hidden;
  if (!$('link-form').hidden) $('link-input').focus();
});

$('file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) shareThen(`Uploading ${file.name}…`, (progress) => uploadFile(file, progress));
});

$('link-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('link-input').value.trim();
  $('link-input').value = '';
  $('link-form').hidden = true;
  shareThen(`Reading ${url}…`, () => addLink(url));
});

$('composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('text').value.trim();
  $('text').value = '';
  if (/^https?:\/\/\S+$/i.test(text)) shareThen(`Reading ${text}…`, () => addLink(text));
  else ask(text);
});

$('btn-ar').addEventListener('click', async () => {
  if (stage.inAR) return stage.exitAR();
  try {
    setCamera(false);
    await stage.enterAR($('call-ui'), {
      onHint: (t) => {
        $('hint').hidden = !t;
        $('hint').textContent = t || '';
      },
      onEnd: () => $('btn-ar').setAttribute('aria-pressed', 'false'),
    });
    $('btn-ar').setAttribute('aria-pressed', 'true');
  } catch (err) {
    addMsg('system', `Couldn't start AR: ${err.message}`);
  }
});

// Taps on call controls shouldn't also count as "place character" taps in AR.
for (const el of document.querySelectorAll('.call-ui > *')) {
  el.addEventListener('beforexrselect', (e) => e.preventDefault());
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('drawer').hidden) openDrawer(false);
});

init();
