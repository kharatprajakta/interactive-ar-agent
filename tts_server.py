"""Local voice service: Kokoro or KittenTTS (speech out) + Whisper (speech in).

POST /tts     {"text": "...", "voice": "Kiki", "speed": 1.0}  ->  audio/wav
              (voice = a character name, or any raw voice id of the engine)
POST /stt     raw 16 kHz mono 16-bit PCM                      ->  {"text": "..."}
GET  /health  -> {"ok": true, "model": "...", "voices": [...], "default_voice": "...", "stt": true}

The Node server starts this automatically when .venv exists; see README.
"""
import io
import json
import os
import sys
import threading
import time
import types
import urllib.request
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np

HOST = os.environ.get("KITTEN_HOST", "127.0.0.1")
PORT = int(os.environ.get("KITTEN_PORT", "5005"))
ENGINE = os.environ.get("TTS_ENGINE", "kokoro").lower()  # "kokoro" (default) or "kitten"
DEFAULT_VOICE = "Kiki"
SAMPLE_RATE = 24000
MAX_CHARS = 1000
CHARACTERS = ["Bruno", "Jasper", "Hugo", "Leo", "Rosie", "Luna", "Kiki", "Bella"]

# ---------------------------------------------------------------------------
# Kokoro-82M (ONNX): the natural-sounding default. Each character gets one of
# its higher-rated voices; any of its 54 voice ids (e.g. "hf_alpha") works too.
# ---------------------------------------------------------------------------
KOKORO_DIR = Path(__file__).resolve().parent / "data" / "kokoro"
KOKORO_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/"
KOKORO_FILES = [os.environ.get("KOKORO_MODEL", "kokoro-v1.0.fp16.onnx"), "voices-v1.0.bin"]
KOKORO_VOICES = {
    "Bruno": "am_fenrir",  # deep, hearty chef
    "Jasper": "am_puck",  # young, upbeat tech helper
    "Hugo": "bm_george",  # older British detective
    "Leo": "am_michael",  # smooth, confident coach
    "Rosie": "af_bella",  # bright, energetic wellness coach
    "Luna": "af_aoede",  # calm, curious scientist
    "Kiki": "af_heart",  # Kokoro's best-rated voice: clear, warm tutor
    "Bella": "bf_emma",  # British traveller
}


class KokoroEngine:
    name = "kokoro"

    def __init__(self):
        KOKORO_DIR.mkdir(parents=True, exist_ok=True)
        for f in KOKORO_FILES:
            target = KOKORO_DIR / f
            if not target.exists():
                print(f"[tts] downloading Kokoro {f} (one-time)...", flush=True)
                tmp = target.with_name(target.name + ".part")
                urllib.request.urlretrieve(KOKORO_RELEASE + f, tmp)
                tmp.replace(target)
        from kokoro_onnx import Kokoro

        self.model_name = KOKORO_FILES[0]
        self.kokoro = Kokoro(str(KOKORO_DIR / KOKORO_FILES[0]), str(KOKORO_DIR / KOKORO_FILES[1]))
        self.raw_voices = set(self.kokoro.get_voices())

    def voices(self):
        return CHARACTERS

    def generate(self, text, voice, speed):
        voice_id = KOKORO_VOICES.get(voice, voice)
        if voice_id not in self.raw_voices:
            raise ValueError(f"unknown voice {voice!r}")
        lang = "en-gb" if voice_id.startswith("b") else "en-us"
        audio, sr = self.kokoro.create(text, voice=voice_id, speed=speed, lang=lang)
        if sr != SAMPLE_RATE:
            raise RuntimeError(f"unexpected sample rate {sr}")
        return audio


# ---------------------------------------------------------------------------
# KittenTTS: the tiny fallback (TTS_ENGINE=kitten, or if Kokoro can't load).
# ---------------------------------------------------------------------------
class KittenEngine:
    name = "kitten"

    def __init__(self):
        # kittentts imports `misaki` (which pulls in spaCy) but never uses it.
        # Stubbing it keeps startup fast and avoids spaCy's native DLLs, which
        # Windows Smart App Control blocks.
        sys.modules.setdefault("misaki", types.SimpleNamespace(en=None, espeak=None))
        import espeakng_loader
        from phonemizer.backend.espeak.wrapper import EspeakWrapper

        EspeakWrapper.set_library(espeakng_loader.get_library_path())
        EspeakWrapper.set_data_path(espeakng_loader.get_data_path())
        from kittentts import KittenTTS

        self.model_name = os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.8")
        self.tts = KittenTTS(self.model_name).model  # skips the wrapper's per-call print

    def voices(self):
        return list(self.tts.voice_aliases) or self.tts.available_voices

    def generate(self, text, voice, speed):
        if voice not in self.voices():
            raise ValueError(f"unknown voice {voice!r}")
        return self.tts.generate(text, voice=voice, speed=speed, clean_text=True)


def load_engine():
    if ENGINE != "kitten":
        try:
            print("[tts] loading Kokoro...", flush=True)
            return KokoroEngine()
        except Exception as err:
            print(f"[tts] Kokoro unavailable ({err}); falling back to KittenTTS", flush=True)
    print("[tts] loading KittenTTS...", flush=True)
    return KittenEngine()


# ---------------------------------------------------------------------------
# Speech recognition: faster-whisper on the CPU (keeps the GPU free for the LLM).
# ---------------------------------------------------------------------------
STT_MODEL = os.environ.get("STT_MODEL", "base.en")
STT_DEVICE = os.environ.get("STT_DEVICE", "cpu")
# Names and jargon the recogniser should expect.
STT_PROMPT = "Bruno, Jasper, Hugo, Leo, Rosie, Luna, Kiki, Bella, NCERT, class 10."
# Whisper's classic hallucinations on silence / noise.
STT_JUNK = {"", "you", "thank you", "thanks for watching", "thank you for watching", "bye", "okay"}
_stt = None
_stt_lock = threading.Lock()


def _load_stt():
    global _stt
    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(STT_MODEL, device=STT_DEVICE, compute_type="int8" if STT_DEVICE == "cpu" else "float16")
        model.transcribe(np.zeros(16000, dtype=np.float32), beam_size=1)  # warm up
        _stt = model
        print(f"[stt] {STT_MODEL} ready on {STT_DEVICE}", flush=True)
    except Exception as err:  # speech recognition is optional; TTS still works
        print(f"[stt] unavailable: {err}", flush=True)


def transcribe(pcm16: bytes) -> str:
    audio = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
    if audio.size < 16000 * 0.25:
        return ""
    with _stt_lock:
        segments, _ = _stt.transcribe(
            audio, language="en", beam_size=1, vad_filter=False,
            condition_on_previous_text=False, initial_prompt=STT_PROMPT,
        )
        kept = [s.text.strip() for s in segments if s.no_speech_prob < 0.6]
    text = " ".join(kept).strip()
    return "" if text.lower().strip(" .!?,") in STT_JUNK else text


_engine = load_engine()
_lock = threading.Lock()  # one ONNX run at a time; requests queue up in order
VOICES = _engine.voices()
MODEL = f"{_engine.name}:{_engine.model_name}"


def synthesize(text: str, voice: str, speed: float) -> bytes:
    with _lock:
        audio = _engine.generate(text, voice, speed)
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


class Handler(BaseHTTPRequestHandler):
    def _send(self, status, body: bytes, content_type: str):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, data):
        self._send(status, json.dumps(data).encode(), "application/json")

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": MODEL, "voices": VOICES, "default_voice": DEFAULT_VOICE, "stt": _stt is not None})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        if self.path == "/stt":
            return self._stt()
        if self.path != "/tts":
            return self._json(404, {"error": "not found"})
        try:
            length = int(self.headers.get("Content-Length", 0))
            body = json.loads(self.rfile.read(length) or b"{}")
            text = str(body.get("text", "")).strip()[:MAX_CHARS]
            voice = body.get("voice") or DEFAULT_VOICE
            speed = float(body.get("speed", 1.0))
        except (ValueError, TypeError):
            return self._json(400, {"error": "invalid JSON body"})
        if not text:
            return self._json(400, {"error": "text is required"})

        started = time.perf_counter()
        try:
            wav = synthesize(text, voice, max(0.5, min(2.0, speed)))
        except ValueError as err:
            return self._json(400, {"error": f"{err}; choose from {VOICES}"})
        except Exception as err:  # surface model errors to the client
            return self._json(500, {"error": str(err)})
        took = time.perf_counter() - started
        seconds = (len(wav) - 44) / 2 / SAMPLE_RATE
        print(f"[tts] {seconds:.1f}s audio in {took:.2f}s: {text[:60]!r}", flush=True)
        self._send(200, wav, "audio/wav")

    def _stt(self):
        if _stt is None:
            return self._json(503, {"error": "speech recognition is still loading or unavailable"})
        length = int(self.headers.get("Content-Length", 0))
        if length > 16000 * 2 * 60:  # one minute max
            return self._json(413, {"error": "audio too long"})
        started = time.perf_counter()
        try:
            text = transcribe(self.rfile.read(length))
        except Exception as err:
            return self._json(500, {"error": str(err)})
        print(f"[stt] {length / 32000:.1f}s audio in {time.perf_counter() - started:.2f}s: {text[:60]!r}", flush=True)
        self._json(200, {"text": text})

    def log_message(self, *args):
        pass  # keep the console quiet; synthesize() logs what matters


if __name__ == "__main__":
    synthesize("Warming up.", DEFAULT_VOICE, 1.0)  # first ONNX run is slow; do it now
    threading.Thread(target=_load_stt, daemon=True).start()
    print(f"[tts] {MODEL} ready on http://{HOST}:{PORT} (voices: {', '.join(VOICES)})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
