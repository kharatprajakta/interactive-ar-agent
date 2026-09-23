# interactive-ar-agent

Talk to **Nova**, an AI companion that appears in your room through augmented reality, right in the browser.

- **A character per voice**: each of the 8 KittenTTS voices has its own animated character from Kenney's [Mini Characters](https://kenney.nl/assets/mini-characters) (CC0). Characters idle, nod hello, turn to face you, tilt their heads while listening or thinking, and bob in time with their speech.
- **AR**:
  - On Android Chrome with ARCore, tap **Enter AR** and then tap the floor to place Nova (WebXR hit-testing).
  - Everywhere else, Nova is overlaid on your live camera feed.
- **Voice + text**: tap the mic to speak (Web Speech API), or type. Replies are spoken aloud sentence by sentence as they stream in. You can interrupt Nova at any time.
- **Neural voice**: [KittenTTS](https://github.com/KittenML/KittenTTS) runs locally on the CPU and offers 8 voices. The character's talking motion follows the real audio level. If KittenTTS isn't set up, the app falls back to the browser's built-in voice.
- **Local AI brain**: runs on [Ollama](https://ollama.com), so nothing leaves your machine.
- **No npm dependencies**: the server is plain Node.js, and three.js loads from a CDN.

## Setup

1. Install [Node.js 18+](https://nodejs.org) and [Ollama](https://ollama.com/download).
2. Pull a model:
   ```sh
   ollama pull llama3.2
   ```
3. *(Optional, recommended)* Set up the KittenTTS voice. This needs **Python 3.12 or older**:
   ```sh
   py -3.12 -m venv .venv                          # macOS/Linux: python3.12 -m venv .venv
   .venv\Scripts\python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python ...
   ```
4. Start the app. If `.venv` exists, this also starts the KittenTTS service; the first run downloads the voice model (about 25 MB):
   ```sh
   npm start
   ```
5. Open http://localhost:3000, press **Start**, and allow camera and microphone access. Pick a voice from the dropdown in the top bar.

## Using it on your phone (real AR)

The camera, microphone, and WebXR only work on a **secure origin** (HTTPS or `localhost`). Use one of these options:

- **USB (Android)**: enable USB debugging, run `adb reverse tcp:3000 tcp:3000`, and then open `http://localhost:3000` in Chrome on the phone.
- **Tunnel**: run `cloudflared tunnel --url http://localhost:3000` (or `ngrok http 3000`) and open the HTTPS URL it prints.
- **Your own certificate**: `SSL_KEY=key.pem SSL_CERT=cert.pem npm start` serves HTTPS directly (for example with a certificate from [mkcert](https://github.com/FiloSottile/mkcert)).

Full WebXR AR needs Android Chrome with [ARCore](https://developers.google.com/ar/devices). iPhone Safari doesn't support WebXR, so it uses camera-overlay mode.

## Configuration

| Env var         | Default                  | Purpose                                  |
| --------------- | ------------------------ | ---------------------------------------- |
| `OLLAMA_MODEL`  | `llama3.2`               | Any chat model you've pulled             |
| `OLLAMA_URL`    | `http://127.0.0.1:11434` | Where Ollama is running                  |
| `PORT`          | `3000`                   | Web server port                          |
| `SYSTEM_PROMPT` | Nova persona             | Change the agent's personality           |
| `SSL_KEY` / `SSL_CERT` | none               | Serve HTTPS with these PEM files         |
| `KITTEN_MODEL`  | `KittenML/kitten-tts-nano-0.8` | Also `-micro-0.8` / `-mini-0.8` (bigger, better) |
| `KITTEN_VOICE`  | `Kiki`                   | Default voice: Bella, Jasper, Luna, Bruno, Rosie, Hugo, Kiki, Leo |
| `TTS_URL`       | `http://127.0.0.1:5005`  | Where the KittenTTS service listens      |
| `TTS_AUTOSTART` | `1`                      | Set to `0` to run `tts_server.py` yourself |

## Project layout

```
server.js          Static file server, /api/chat (streams from Ollama), /api/tts proxy
tts_server.py      KittenTTS HTTP service (text -> WAV), auto-started by server.js
public/index.html  Page shell and UI
public/main.js     Scene, AR session, camera, and the conversation loop
public/avatar.js   Loads/animates the Kenney characters; voice -> character mapping
public/models/     Kenney Mini Characters (GLB + shared texture, CC0)
public/voice.js    Speech recognition + text-to-speech
public/style.css   UI styling
```

**Windows note:** `tts_server.py` stubs out KittenTTS's unused `misaki`/spaCy import. That keeps startup fast and avoids spaCy DLLs that Windows Smart App Control blocks.

To change which character goes with which voice, edit `VOICE_CHARACTERS` in `public/avatar.js`. The full Mini Characters pack has 12 characters, and any rigged `.glb` with an `idle` clip and a `head` bone will work.
