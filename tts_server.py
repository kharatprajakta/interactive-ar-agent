"""Tiny KittenTTS HTTP service (stdlib only, apart from kittentts itself).

POST /tts     {"text": "...", "voice": "Kiki", "speed": 1.0}  ->  audio/wav
GET  /health  -> {"ok": true, "model": "...", "voices": [...], "default_voice": "..."}

The Node server starts this automatically when .venv exists; see README.
"""
import io
import json
import os
import sys
import threading
import time
import types
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

# kittentts imports `misaki` (which pulls in spaCy) but never uses it. Stubbing it
# keeps startup fast and avoids spaCy's native DLLs, which Windows Smart App
# Control blocks.
sys.modules.setdefault("misaki", types.SimpleNamespace(en=None, espeak=None))

import espeakng_loader  # noqa: E402
from phonemizer.backend.espeak.wrapper import EspeakWrapper  # noqa: E402

EspeakWrapper.set_library(espeakng_loader.get_library_path())
EspeakWrapper.set_data_path(espeakng_loader.get_data_path())

from kittentts import KittenTTS  # noqa: E402

HOST = os.environ.get("KITTEN_HOST", "127.0.0.1")
PORT = int(os.environ.get("KITTEN_PORT", "5005"))
MODEL = os.environ.get("KITTEN_MODEL", "KittenML/kitten-tts-nano-0.8")
DEFAULT_VOICE = os.environ.get("KITTEN_VOICE", "Kiki")
SAMPLE_RATE = 24000
MAX_CHARS = 1000

print(f"[tts] loading {MODEL} ...", flush=True)
_tts = KittenTTS(MODEL).model  # the ONNX model; skips the wrapper's per-call print
_lock = threading.Lock()  # one ONNX run at a time; requests queue up in order
VOICES = list(_tts.voice_aliases) or _tts.available_voices


def synthesize(text: str, voice: str, speed: float) -> bytes:
    with _lock:
        audio = _tts.generate(text, voice=voice, speed=speed, clean_text=True)
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
            self._json(200, {"ok": True, "model": MODEL, "voices": VOICES, "default_voice": DEFAULT_VOICE})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
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
        if voice not in VOICES:
            return self._json(400, {"error": f"unknown voice {voice!r}; choose from {VOICES}"})

        started = time.perf_counter()
        try:
            wav = synthesize(text, voice, max(0.5, min(2.0, speed)))
        except Exception as err:  # surface model errors to the client
            return self._json(500, {"error": str(err)})
        took = time.perf_counter() - started
        seconds = (len(wav) - 44) / 2 / SAMPLE_RATE
        print(f"[tts] {seconds:.1f}s audio in {took:.2f}s: {text[:60]!r}", flush=True)
        self._send(200, wav, "audio/wav")

    def log_message(self, *args):
        pass  # keep the console quiet; synthesize() logs what matters


if __name__ == "__main__":
    synthesize("Warming up.", DEFAULT_VOICE, 1.0)  # first ONNX run is slow; do it now
    print(f"[tts] ready on http://{HOST}:{PORT} (voices: {', '.join(VOICES)})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
