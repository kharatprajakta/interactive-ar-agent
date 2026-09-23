// Speech in and out.
//   Voice    – speaks replies: KittenTTS (neural, via /api/tts, played through
//              Web Audio so we can measure loudness) or the browser's voice.
//   Listener      – hands-free listening with the browser's Web Speech API
//                   (Chrome/Edge send the audio to their cloud service).
//   LocalListener – hands-free listening that stays on this machine: Silero
//                   voice-activity detection in the browser + Whisper on our
//                   server. Used whenever the server has speech recognition.
// Both share the same interface: start / pause / resume / stop and the
// onInterim / onUtterance / onError / onActiveChange callbacks.

function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\\times/g, ' times ') // LaTeX that small models like to emit
    .replace(/[*_`#>~|$\\]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Voice {
  constructor({ onSpeakingChange = () => {}, onBoundary = () => {}, onSentence = () => {} } = {}) {
    this.onSpeakingChange = onSpeakingChange;
    this.onBoundary = onBoundary;
    this.onSentence = onSentence; // called as each sentence starts playing (for captions)
    this.synth = window.speechSynthesis || null;
    this.muted = false;
    this.pending = 0;
    this.generation = 0;
    this.browserVoices = [];
    this.gender = 'f';

    this.engine = 'browser';
    this.kittenVoice = null;
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.playChain = Promise.resolve();
    this.abort = new AbortController();

    if (this.synth) {
      const load = () => (this.browserVoices = this.synth.getVoices().filter((v) => /^en/i.test(v.lang)));
      load();
      this.synth.addEventListener?.('voiceschanged', load);
    }
  }

  /** Call from a user gesture so mobile browsers allow audio later. */
  unlock() {
    this.stop();
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx && !this.audioCtx) {
      this.audioCtx = new AudioCtx();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(this.audioCtx.destination);
      this.levelBuffer = new Float32Array(this.analyser.fftSize);
    }
    this.audioCtx?.resume();
    this.synth?.speak(new SpeechSynthesisUtterance(''));
  }

  /** Use a persona's voice: KittenTTS name if available, else a browser voice of that gender. */
  setPersonaVoice({ voice, gender }, kittenAvailable) {
    this.gender = gender;
    this.engine = kittenAvailable ? 'kitten' : 'browser';
    this.kittenVoice = voice;
  }

  get speaking() {
    return this.pending > 0;
  }

  /** Current loudness (RMS) of KittenTTS playback, or null if it can't be measured. */
  get level() {
    if (!this.source) return null;
    this.analyser.getFloatTimeDomainData(this.levelBuffer);
    let sum = 0;
    for (const v of this.levelBuffer) sum += v * v;
    return Math.sqrt(sum / this.levelBuffer.length);
  }

  speak(text) {
    const clean = cleanForSpeech(text);
    if (!clean || this.muted) return;
    // A suspended AudioContext (no user gesture yet) would never finish playing,
    // so only use KittenTTS once Web Audio is actually running.
    if (this.engine === 'kitten' && this.audioCtx?.state === 'running') this._speakKitten(clean);
    else this._speakBrowser(clean);
  }

  _begin() {
    if (!this.pending) this.onSpeakingChange(true);
    this.pending++;
  }

  // Late callbacks from cancelled speech are ignored via the generation counter.
  _finish(generation) {
    if (generation !== this.generation) return;
    this.pending = Math.max(0, this.pending - 1);
    if (!this.pending) this.onSpeakingChange(false);
  }

  _pickBrowserVoice() {
    const female = /female|woman|samantha|zira|aria|jenny|susan|karen|moira|tessa|victoria|google uk english female|google us english/i;
    const male = /male|man|david|mark|guy|daniel|alex|fred|google uk english male/i;
    const want = this.gender === 'm' ? male : female;
    return this.browserVoices.find((v) => want.test(v.name) && !(this.gender === 'm' ? female : /\bmale\b/i).test(v.name)) || this.browserVoices[0] || null;
  }

  _speakBrowser(text) {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(text);
    const v = this._pickBrowserVoice();
    if (v) u.voice = v;
    u.rate = 1.03;
    u.pitch = this.gender === 'm' ? 0.95 : 1.1;
    const generation = this.generation;
    u.onstart = () => generation === this.generation && this.onSentence(text);
    u.onboundary = () => generation === this.generation && this.onBoundary();
    u.onend = u.onerror = () => this._finish(generation);
    this._begin();
    this.synth.speak(u);
  }

  _speakKitten(text) {
    const generation = this.generation;
    this._begin();

    // Synthesize right away so it overlaps with playback of earlier sentences...
    const audio = fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: this.kittenVoice }),
      signal: this.abort.signal,
    }).then(async (r) => {
      if (!r.ok) throw new Error(await r.text());
      return this.audioCtx.decodeAudioData(await r.arrayBuffer());
    });
    audio.catch(() => {}); // handled in the chain below

    // ...but play strictly in order.
    this.playChain = this.playChain.then(async () => {
      if (generation !== this.generation) return;
      try {
        await this._play(await audio, generation, text);
      } catch (err) {
        if (generation !== this.generation) return;
        console.warn('KittenTTS failed; switching to the browser voice.', err);
        this.engine = 'browser';
        this._speakBrowser(text);
      } finally {
        this._finish(generation);
      }
    });
  }

  _play(buffer, generation, text) {
    return new Promise((resolvePlay) => {
      if (generation !== this.generation) return resolvePlay();
      const src = this.audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.analyser);
      src.onended = () => {
        if (this.source === src) this.source = null;
        resolvePlay();
      };
      this.source = src;
      this.onSentence(text);
      src.start();
    });
  }

  stop() {
    const wasSpeaking = this.pending > 0;
    this.generation++;
    this.pending = 0;
    this.synth?.cancel();
    this.abort.abort();
    this.abort = new AbortController();
    this.source?.stop();
    if (wasSpeaking) this.onSpeakingChange(false);
  }
}

/**
 * Always-on listening for a call. Emits:
 *   onInterim(text)   – live partial transcript while the user talks
 *   onUtterance(text) – a finished thing the user said (phrases merged)
 *   onError(code)     – e.g. 'not-allowed'
 */
export class Listener {
  static get supported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  constructor({ onInterim = () => {}, onUtterance = () => {}, onError = () => {}, onActiveChange = () => {} } = {}) {
    this.onInterim = onInterim;
    this.onUtterance = onUtterance;
    this.onError = onError;
    this.onActiveChange = onActiveChange;
    this.wanted = false;
    this.rec = null;
    this.buffer = '';
    this.flushTimer = null;
    this.restarts = 0;
  }

  start() {
    if (!Listener.supported || this.wanted) return;
    this.wanted = true;
    this.paused = false;
    this.restarts = 0;
    this._open();
  }

  /**
   * Stop hearing anything (e.g. while the agent talks, so it can't hear its own
   * voice through the speakers). Whatever was half-heard is thrown away.
   */
  pause() {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    clearTimeout(this.flushTimer);
    this.buffer = '';
    this.interim = '';
    const rec = this.rec;
    this.rec = null; // detach first so its late events are ignored
    try {
      rec?.abort();
    } catch {}
    this.onActiveChange(false);
  }

  resume() {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this._open();
  }

  stop() {
    this.wanted = false;
    this.paused = false;
    clearTimeout(this.flushTimer);
    this.buffer = '';
    this.interim = '';
    try {
      this.rec?.abort();
    } catch {}
    this.rec = null;
    this.onActiveChange(false);
  }

  _open() {
    this.consumed = -1; // result indices restart with each recognizer
    this.lastIndex = -1;
    this.interim = '';
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    rec.onstart = () => this.onActiveChange(true);

    rec.onresult = (e) => {
      if (this.rec !== rec) return; // paused or replaced
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (i <= this.consumed) continue; // already sent (see _flush)
        const r = e.results[i];
        if (r.isFinal) {
          this.buffer += ' ' + r[0].transcript;
          this.consumed = i;
        } else interim += r[0].transcript;
      }
      this.interim = interim.trim();
      this.lastIndex = e.results.length - 1;
      const live = (this.buffer + ' ' + this.interim).trim();
      clearTimeout(this.flushTimer);
      if (!live) return;
      this.onInterim(live);
      // Send after a short pause, so "um… I was wondering" arrives as one
      // message. Chrome (especially on Android) sometimes never finalizes a
      // phrase, so also send if the partial text just stops changing.
      this.flushTimer = setTimeout(() => this._flush(), this.interim ? 1400 : 800);
    };

    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'network') {
        this.wanted = false;
        this.onError(e.error);
      } else if (e.error !== 'no-speech' && e.error !== 'aborted') {
        this.onError(e.error);
      }
    };

    // Chrome ends recognition after silence or ~a minute; quietly reopen.
    rec.onend = () => {
      if (this.rec !== rec) return; // paused or replaced: nothing to flush or reopen
      this.onActiveChange(false);
      this._flush();
      if (!this.wanted) return;
      this.restarts++;
      setTimeout(() => this.wanted && this.rec === rec && this._open(), this.restarts > 20 ? 1000 : 150);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch (err) {
      console.warn('recognition start failed', err);
    }
  }

  _flush() {
    clearTimeout(this.flushTimer);
    let text = this.buffer;
    if (this.interim) {
      text += ' ' + this.interim;
      this.interim = '';
      this.consumed = Math.max(this.consumed, this.lastIndex); // don't resend when Chrome finalizes it later
    }
    this.buffer = '';
    text = text.trim();
    if (text) this.onUtterance(text);
  }
}

// ---------------------------------------------------------------------------
// Local speech recognition
// ---------------------------------------------------------------------------
const VAD_BASE = 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/';
const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const el = Object.assign(document.createElement('script'), { src, async: true });
    el.onload = resolve;
    el.onerror = () => reject(new Error(`Couldn't load ${src}`));
    document.head.appendChild(el);
  });
}

function toPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) out[i] = Math.max(-1, Math.min(1, float32[i])) * 0x7fff;
  return out;
}

export class LocalListener {
  static get supported() {
    return !!navigator.mediaDevices?.getUserMedia && 'AudioWorkletNode' in window;
  }

  constructor({ onInterim = () => {}, onUtterance = () => {}, onError = () => {}, onActiveChange = () => {} } = {}) {
    this.onInterim = onInterim;
    this.onUtterance = onUtterance;
    this.onError = onError;
    this.onActiveChange = onActiveChange;
    this.wanted = false;
    this.paused = false;
    this.vad = null;
    this.generation = 0; // bumps on pause/stop so in-flight transcriptions are dropped
  }

  async start() {
    if (this.wanted) return;
    this.wanted = true;
    this.paused = false;
    try {
      await this._ensure();
      if (this.wanted && !this.paused) await this.vad.start();
      this.onActiveChange(this.wanted && !this.paused);
    } catch (err) {
      console.error('Local speech recognition failed to start', err);
      this.wanted = false;
      this.onError(/permission|notallowed/i.test(`${err.name} ${err.message}`) ? 'not-allowed' : 'local-failed');
    }
  }

  pause() {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    this.generation++;
    this.vad?.pause();
    this.onActiveChange(false);
  }

  resume() {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this.vad?.start();
    this.onActiveChange(true);
  }

  stop() {
    this.wanted = false;
    this.paused = false;
    this.generation++;
    this.vad?.pause();
    this.onActiveChange(false);
  }

  async _ensure() {
    if (this.vad) return;
    this.loading ??= (async () => {
      await loadScript(`${ORT_BASE}ort.wasm.min.js`);
      await loadScript(`${VAD_BASE}bundle.min.js`);
      this.vad = await window.vad.MicVAD.new({
        model: 'v5',
        baseAssetPath: VAD_BASE,
        onnxWASMBasePath: ORT_BASE,
        startOnLoad: false,
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        redemptionMs: 700, // this much silence ends the sentence
        minSpeechMs: 250,
        preSpeechPadMs: 300,
        submitUserSpeechOnPause: false,
        // Echo cancellation keeps the agent's own voice (from the speakers) out.
        getStream: () =>
          navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          }),
        onSpeechStart: () => this._live() && this.onInterim('…'),
        onVADMisfire: () => this._live() && this.onUtterance(''),
        onSpeechEnd: (audio) => this._transcribe(audio),
      });
    })();
    await this.loading;
  }

  _live() {
    return this.wanted && !this.paused;
  }

  async _transcribe(audio) {
    if (!this._live()) return;
    const generation = this.generation;
    this.onInterim('…');
    try {
      const res = await fetch('/api/stt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: toPcm16(audio).buffer,
      });
      const { text = '', error } = await res.json();
      if (error) throw new Error(error);
      if (generation === this.generation && this._live()) this.onUtterance(text.trim());
    } catch (err) {
      console.warn('transcription failed', err);
      if (generation === this.generation) this.onUtterance('');
    }
  }
}
