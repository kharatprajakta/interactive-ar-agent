# Hello Crew: hands-free video calls with AI personalities

Pick someone from the contact list and call them. Each character lives in their own 3D room with its own voice, personality and speciality. You talk to them hands-free, like a video call, and they potter about their space: Bruno heads to the stove while he thinks, and Hugo goes to his laptop to check a claim.

| | Role | Room | Special ability |
|---|---|---|---|
| **Bruno** | Chef | Kitchen | Recipes, meal plans, substitutions |
| **Jasper** | Tech Helper | Desk | Coding, gadgets, troubleshooting |
| **Hugo** | Fact Checker | Detective's office | Searches the web for almost every claim and names his sources |
| **Leo** | Money & Career Coach | Lounge | Budgets, interviews, decisions |
| **Rosie** | Wellness Coach | Park | Workouts, sleep, stress relief |
| **Luna** | Science Explainer | Moon base | Space, science, how things work |
| **Kiki** | NCERT Tutor | Library | Confirms your class and subject, then teaches only from that NCERT textbook |
| **Bella** | Travel Planner | Campsite | Trips, itineraries, hidden gems |

**Every call includes:**
- **Hands-free voice, on-device.** The mic stays open like a meeting. Silero voice-activity detection runs in the browser, and Whisper transcribes on your machine, so no cloud speech service is needed (the browser's Web Speech API is only a fallback). The mic pauses while the character talks; tap the screen to interrupt.
- **Live captions, a call timer, and an optional self-view camera.**
- **Web search.** A small "router" step decides when a question needs current information (weather, news, prices…). The character then searches DuckDuckGo, reads the top pages, and cites them.
- **Your documents (RAG).** Upload a PDF or text file, or paste a link, from the chat drawer. The server embeds it with `nomic-embed-text`, and every character can answer from it.
- **Accounts and memory.** Sign up with your name, email and password, and the crew remembers *you* on any device. Each character keeps your chat history with them. The whole crew shares a small profile: how you like to talk (e.g. Hinglish, short answers), key facts you've mentioned (city, diet, job, goals…), and Kiki's study progress, so she can pick up where you left off. A background step updates the profile after each reply. **🧠 Memory** on the home page shows everything they remember; you can forget any item or erase it all. Everything is stored locally in `data/hellocrew.db` (SQLite). Passwords are scrypt-hashed, and logins use an HttpOnly session cookie.
- **AR.** On Android Chrome with ARCore, the **AR** button brings the character into your real room.

Everything runs locally: [Ollama](https://ollama.com) for the chat model and embeddings, [Kokoro-82M](https://github.com/thewh1teagle/kokoro-onnx) for the voices (with [KittenTTS](https://github.com/KittenML/KittenTTS) as a fallback), [faster-whisper](https://github.com/SYSTRAN/faster-whisper) for speech recognition, and [ChromaDB](https://www.trychroma.com) for the textbooks. Characters and rooms are [Kenney](https://kenney.nl) assets (CC0).

## Setup

1. Install [Node.js 22.13+](https://nodejs.org) (for its built-in SQLite), [Ollama](https://ollama.com/download), and **Python 3.12 or older** (KittenTTS doesn't support 3.13 yet).
2. Pull the models:
   ```sh
   ollama pull qwen3.5:4b
   ollama pull nomic-embed-text
   ```
3. Set up the Python helpers (voices, on-device speech recognition, NCERT textbook search):
   ```sh
   py -3.12 -m venv .venv                                    # macOS/Linux: python3.12 -m venv .venv
   .venv\Scripts\python -m pip install -r requirements.txt   # macOS/Linux: .venv/bin/python -m pip ...
   ```
4. Start everything. This one command also launches the voice and textbook services. On first run it downloads the Kokoro voice model (about 200 MB) and the Whisper model:
   ```sh
   npm start
   ```
5. Open http://localhost:3000 in **Chrome or Edge** and call someone. Allow microphone access.

Without the Python helpers the app still works: it uses the browser's built-in voices, and Kiki explains from general knowledge.

## NCERT textbooks (for Kiki)

Kiki answers only from textbooks you've indexed into the local ChromaDB (`data/chroma`). Index them with:

```sh
# Download and index straight from ncert.nic.in (see `books` for known codes)
.venv\Scripts\python -m ncert.ingest download jesc1 jemh1        # Class 10 Science + Maths
.venv\Scripts\python -m ncert.ingest books                       # list known book codes

# Or index PDFs you've downloaded yourself (one PDF per chapter, e.g. jesc101.pdf…)
.venv\Scripts\python -m ncert.ingest folder "C:\Downloads\jesc1dd" --class 10 --subject science

.venv\Scripts\python -m ncert.ingest list                        # what's indexed
```

NCERT names chapter PDFs `<book code><chapter>.pdf` (e.g. `jesc101.pdf` is Class 10 Science, chapter 1). If `download` can't reach ncert.nic.in, get the book's zip from https://ncert.nic.in/textbook.php in your browser, unzip it, and use `folder`. The prelims, answers and appendix files are skipped automatically. Restart `npm start` after indexing, or wait a minute for the catalogue to refresh.

Each textbook is stored in its own ChromaDB collection (e.g. `ncert_c10_science`). All ten English-medium Class 10 books are supported: `jesc1 jemh1 jess1 jess2 jess3 jess4 jeff1 jefp1 jewe2 jehp1`. Hindi and Sanskrit books are left out because their PDFs use legacy fonts or scanned pages.

**How Kiki works:**
1. On every turn, a structured extraction step works out your **class**, **subject**, **chapter** and **topic** from the conversation. The class must come from you, never a guess.
2. If anything is missing, she asks for it. Before teaching, she repeats the book back ("Class 10 Science, is that right?") and waits for your yes. If you correct her, she confirms the new choice instead.
3. After you confirm, she opens only that book's collection. She searches the chapter you named, or finds the single best-matching chapter and stays inside it, then answers from those excerpts and cites the chapter and page. If the book doesn't cover your question, she says so.
4. In a call with Kiki, the **Books** button (or the 📖 chip) opens a bookshelf. Tap a book or chapter to pick it without speaking.

## Using it on your phone

The mic, camera and AR need **HTTPS** (or `localhost`). Pick one:

- **Tunnel (easiest):** run `cloudflared tunnel --url http://localhost:3000`, then open the `https://….trycloudflare.com` link it prints.
- **USB (Android):** run `adb reverse tcp:3000 tcp:3000`, then open `http://localhost:3000` in Chrome on the phone.
- **Your own certificate:** `SSL_KEY=key.pem SSL_CERT=cert.pem npm start`.

**Before sharing a link, set an invite code.** Otherwise anyone who finds the URL can create an account and use your machine. Put it in a `.env` file in the project folder (gitignored; `npm start` loads it):

```sh
INVITE_CODE=crew-some-secret-words-123     # several codes: separate with commas
```

Restart the server, and new sign-ups must enter the code. Existing users sign in as usual. Remove a code and restart to stop new sign-ups with it. Links shared into the app can't reach private or local network addresses.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `qwen3.5:4b` | Chat model. `llama3.2` replies faster (~0.3 s vs ~0.7 s) but is less capable. "Thinking" is switched off automatically |
| `STT_MODEL` / `STT_DEVICE` | `base.en` / `cpu` | Whisper model for on-device speech recognition (`small.en` is more accurate but slower) |
| `EMBED_MODEL` | `nomic-embed-text` | Embeddings for documents, web pages and textbooks |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Where Ollama runs |
| `PORT` | `3000` | Web server port |
| `TTS_ENGINE` | `kokoro` | `kitten` for the tiny KittenTTS voices instead |
| `KOKORO_MODEL` | `kokoro-v1.0.fp16.onnx` | Kokoro model file (downloaded to `data/kokoro/`) |
| `KITTEN_MODEL` | `KittenML/kitten-tts-nano-0.8` | KittenTTS model when `TTS_ENGINE=kitten` |
| `TTS_URL` / `NCERT_URL` | `:5005` / `:5006` | Where the Python helpers listen |
| `TTS_AUTOSTART` / `NCERT_AUTOSTART` | on | Set to `0` to run a helper yourself |
| `NCERT_DB` | `data/chroma` | ChromaDB folder for the textbooks |
| `DB_PATH` | `data/hellocrew.db` | SQLite file for accounts and memory |
| `INVITE_CODE` | none (open sign-up) | Code(s) needed to create an account, comma-separated. Set this before sharing a link |
| `DEBUG_CHAT` | off | Log Kiki's extracted study context |
| `SSL_KEY` / `SSL_CERT` | none | Serve HTTPS directly |

## How it fits together

```
server.js            Static files, accounts (/api/auth), /api/chat (NDJSON events), /api/call, /api/memory, /api/docs, /api/tts; starts the Python helpers
lib/db.js            SQLite schema: users, sessions, messages, memory
lib/auth.js          Sign up / sign in (scrypt), session cookies, login rate limiting
lib/memory.js        Per-user chat history, the shared profile (language, style, facts, study), learning from each turn, greetings
lib/personas.js      The eight characters: voice, model, room, prompt
lib/chat.js          One turn: links, then documents, then the NCERT textbook or a web-search decision, then a streamed reply
lib/web.js           DuckDuckGo search, safe page fetching (private-network guard), HTML to text
lib/rag.js           Chunking + Ollama embeddings + in-memory vector search for shared documents
tts_server.py        Voice service: KittenTTS (text to WAV) + faster-whisper (speech to text)
ncert/               ChromaDB textbook store, ingestion CLI, and search service
public/app.js        Landing page, call lifecycle, hands-free conversation, captions, chat drawer
public/stage.js      3D room, character direction (home, work and idle spots), video-call camera, AR
public/scenes.js     The eight rooms, laid out with Kenney props
public/avatar.js     Character loading and animation (walk, interact, head motion, talking bob)
public/voice.js      Speech out (KittenTTS/browser); hands-free speech in (local VAD+Whisper, or Web Speech)
public/docs.js       PDF to text in the browser (pdf.js), document API calls
```

**Voices:** each character has their own Kokoro voice: Bruno `am_fenrir`, Jasper `am_puck`, Hugo `bm_george`, Leo `am_michael`, Rosie `af_bella`, Luna `af_aoede`, Kiki `af_heart`, and Bella `bf_emma`. To change one, edit `KOKORO_VOICES` in `tts_server.py`. Kokoro has 54 voices, including Hindi (`hf_alpha`, `hm_omega`…), British, and more.

**Notes:**
- With the Python voice service running, speech recognition happens on your machine. Without it, the app falls back to the browser's Web Speech API, which in Chrome and Edge sends audio to the vendor's cloud service. It doesn't work at all in Brave, Opera or some embedded browsers.
- Windows: `tts_server.py` skips KittenTTS's unused `misaki`/spaCy import. That library's DLLs are blocked by Smart App Control. Kokoro runs on ONNX Runtime, which isn't blocked.
