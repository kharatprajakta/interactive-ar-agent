// Browser-native speech: SpeechRecognition for listening, speechSynthesis for talking.

function cleanForSpeech(text) {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Voice {
  constructor({ onSpeakingChange = () => {}, onBoundary = () => {} } = {}) {
    this.onSpeakingChange = onSpeakingChange;
    this.onBoundary = onBoundary;
    this.synth = window.speechSynthesis || null;
    this.SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition || null;
    this.canListen = !!this.SpeechRecognition;
    this.muted = false;
    this.pending = 0;
    this.generation = 0;
    this.rec = null;
    this.voice = null;

    // KittenTTS (server-side neural voice), played through Web Audio so we can
    // measure loudness for lip-sync. Falls back to speechSynthesis.
    this.engine = 'browser';
    this.kittenVoice = null;
    this.audioCtx = null;
    this.analyser = null;
    this.source = null;
    this.playChain = Promise.resolve();
    this.abort = new AbortController();

    if (this.synth) {
      const pick = () => {
        const voices = this.synth.getVoices();
        const english = voices.filter((v) => /^en/i.test(v.lang));
        this.voice =
          english.find((v) => /natural|neural|google|samantha|aria|jenny/i.test(v.name)) ||
          english[0] ||
          voices[0] ||
          null;
      };
      pick();
      this.synth.addEventListener?.('voiceschanged', pick);
    }
  }

  /** Call from a user gesture so mobile browsers allow later speech. */
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

  useKitten(voiceName) {
    this.engine = 'kitten';
    this.kittenVoice = voiceName;
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
    if (this.engine === 'kitten' && this.audioCtx) this._speakKitten(clean);
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

  _speakBrowser(text) {
    if (!this.synth) return;
    const u = new SpeechSynthesisUtterance(text);
    if (this.voice) u.voice = this.voice;
    u.rate = 1.03;
    u.pitch = 1.15;
    const generation = this.generation;
    u.onboundary = () => generation === this.generation && this.onBoundary();
    u.onend = u.onerror = () => this._finish(generation);
    this._begin();
    this.synth.speak(u);
  }

  _speakKitten(text) {
    const generation = this.generation;
    this._begin();

    // Synthesize right away so it overlaps with playback of earlier sentences.
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
        await this._play(await audio, generation);
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

  _play(buffer, generation) {
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

  /**
   * Listen for one utterance. Calls onInterim with the running transcript and
   * onEnd(finalText, errorCode) once recognition stops.
   */
  listen({ onInterim = () => {}, onEnd = () => {} } = {}) {
    if (!this.canListen || this.rec) return;
    const rec = new this.SpeechRecognition();
    rec.lang = navigator.language || 'en-US';
    rec.interimResults = true;
    rec.continuous = false;

    let finalText = '';
    let error = null;
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      onInterim(finalText + interim);
    };
    rec.onerror = (e) => {
      error = e.error;
    };
    rec.onend = () => {
      this.rec = null;
      onEnd(finalText.trim(), error);
    };
    this.rec = rec;
    rec.start();
  }

  stopListening() {
    this.rec?.stop();
  }

  get listening() {
    return !!this.rec;
  }
}
