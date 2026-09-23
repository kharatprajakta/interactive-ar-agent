// Zero-dependency web server: serves the front end from ./public, runs the
// persona chat pipeline (Ollama + web search + document RAG), and proxies
// text-to-speech to the KittenTTS service.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS, publicPersona } from './lib/personas.js';
import { respond, CHAT_MODEL } from './lib/chat.js';
import { addDocument, listDocuments, removeDocument, EMBED_MODEL } from './lib/rag.js';
import { fetchPage } from './lib/web.js';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const TTS_URL = (process.env.TTS_URL || 'http://127.0.0.1:5005').replace(/\/$/, '');
const NCERT_URL = (process.env.NCERT_URL || 'http://127.0.0.1:5006').replace(/\/$/, '');
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(ROOT_DIR, 'public');
const MAX_DOC_CHARS = 2_000_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

function readBody(req, limit = 1_000_000) {
  return readBuffer(req, limit).then((buf) => buf.toString('utf8'));
}

function readBuffer(req, limit) {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
      } else {
        chunks.push(chunk);
      }
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req, limit) {
  try {
    return JSON.parse(await readBody(req, limit));
  } catch {
    return null;
  }
}

function validSession(id) {
  return typeof id === 'string' && /^[\w-]{8,64}$/.test(id);
}

async function serveStatic(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = resolve(PUBLIC_DIR, '.' + pathname);
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendText(res, 403, 'Forbidden');

  try {
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
async function ttsHealth() {
  try {
    const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

async function ncertHealth() {
  try {
    return await (await fetch(`${NCERT_URL}/health`, { signal: AbortSignal.timeout(2000) })).json();
  } catch {
    return { ok: false };
  }
}

async function handleHealth(res) {
  const [tts, ncert] = await Promise.all([ttsHealth(), ncertHealth()]);
  let names = [];
  let error = null;
  try {
    const { models = [] } = await (await fetch(`${OLLAMA_URL}/api/tags`)).json();
    names = models.map((m) => m.name);
  } catch {
    error = `Can't reach Ollama at ${OLLAMA_URL}. Start it with: ollama serve`;
  }
  const has = (m) => names.includes(m) || names.includes(`${m}:latest`);
  if (!error && !has(CHAT_MODEL)) error = `Model "${CHAT_MODEL}" isn't downloaded yet. Run: ollama pull ${CHAT_MODEL}`;
  sendJson(res, 200, {
    ok: !error,
    model: CHAT_MODEL,
    rag: has(EMBED_MODEL),
    tts,
    ncert,
    error,
    warning: !error && !has(EMBED_MODEL) ? `Document search is off until you run: ollama pull ${EMBED_MODEL}` : null,
  });
}

// ---------------------------------------------------------------------------
// Chat: newline-delimited JSON events (see lib/chat.js)
// ---------------------------------------------------------------------------
async function handleChat(req, res) {
  const body = await readJson(req);
  if (!body) return sendText(res, 400, 'Invalid JSON body');
  const persona = PERSONAS.find((p) => p.id === body.persona);
  if (!persona) return sendText(res, 400, 'Unknown persona');
  if (!validSession(body.session)) return sendText(res, 400, 'Missing session');
  const messages = (Array.isArray(body.messages) ? body.messages : []).filter(
    (m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  );
  if (messages.at(-1)?.role !== 'user') return sendText(res, 400, 'The last message must be from the user');

  const controller = new AbortController();
  res.on('close', () => controller.abort());
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  try {
    for await (const event of respond({ persona, messages, sessionId: body.session, signal: controller.signal })) {
      if (controller.signal.aborted) break;
      res.write(JSON.stringify(event) + '\n');
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('Chat error:', err.message);
      res.write(JSON.stringify({ type: 'error', text: err.message }) + '\n');
    }
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Documents (RAG): PDFs are parsed in the browser and arrive as text.
// ---------------------------------------------------------------------------
async function handleDocs(req, res, url) {
  const session = url.searchParams.get('session');
  if (req.method === 'GET') {
    if (!validSession(session)) return sendText(res, 400, 'Missing session');
    return sendJson(res, 200, { docs: listDocuments(session) });
  }
  if (req.method === 'DELETE') {
    if (!validSession(session)) return sendText(res, 400, 'Missing session');
    return sendJson(res, 200, { removed: removeDocument(session, url.searchParams.get('id')) });
  }
  if (req.method === 'POST') {
    const body = await readJson(req, 8_000_000);
    if (!body || !validSession(body.session)) return sendText(res, 400, 'Invalid request');
    try {
      let doc;
      if (body.url) {
        const page = await fetchPage(body.url);
        doc = await addDocument(body.session, { title: page.title, text: page.text, source: page.url, type: 'link' });
      } else if (typeof body.text === 'string' && body.text.trim()) {
        doc = await addDocument(body.session, {
          title: String(body.title || 'Document').slice(0, 200),
          text: body.text.slice(0, MAX_DOC_CHARS),
          type: body.type === 'pdf' ? 'pdf' : 'text',
        });
      } else {
        return sendText(res, 400, 'Send either a url or some text');
      }
      return sendJson(res, 200, { doc });
    } catch (err) {
      return sendJson(res, 422, { error: err.message });
    }
  }
  sendText(res, 405, 'Method not allowed');
}

async function handleTts(req, res) {
  let upstream;
  try {
    upstream = await fetch(`${TTS_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: await readBody(req, 20_000),
    });
  } catch {
    return sendText(res, 502, `Can't reach the KittenTTS service at ${TTS_URL}`);
  }
  const audio = Buffer.from(await upstream.arrayBuffer());
  res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') || 'audio/wav' });
  res.end(audio);
}

// Speech-to-text: the browser sends raw 16 kHz 16-bit PCM of one utterance.
async function handleStt(req, res) {
  let audio;
  try {
    audio = await readBuffer(req, 16000 * 2 * 60);
  } catch {
    return sendText(res, 413, 'Audio too long');
  }
  try {
    const upstream = await fetch(`${TTS_URL}/stt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: audio,
      signal: AbortSignal.timeout(30000),
    });
    res.writeHead(upstream.status, { 'Content-Type': MIME['.json'] });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch {
    sendJson(res, 502, { error: `Can't reach the speech service at ${TTS_URL}` });
  }
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;
  try {
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/personas' && req.method === 'GET') return sendJson(res, 200, { personas: PERSONAS.map(publicPersona) });
    if (pathname === '/api/docs') return await handleDocs(req, res, url);
    if (pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res);
    if (pathname === '/api/stt' && req.method === 'POST') return await handleStt(req, res);
    if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendText(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.end();
  }
}

// Camera, mic and WebXR need a secure context. localhost counts as secure; for
// a phone on your LAN, provide a certificate via SSL_KEY / SSL_CERT (or use a tunnel).
const useHttps = process.env.SSL_KEY && process.env.SSL_CERT;
const server = useHttps
  ? https.createServer({ key: readFileSync(process.env.SSL_KEY), cert: readFileSync(process.env.SSL_CERT) }, handler)
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`AI call app running at ${scheme}://localhost:${PORT}`);
  console.log(`Using Ollama model "${CHAT_MODEL}" (+ "${EMBED_MODEL}" for documents) at ${OLLAMA_URL}`);
});

// Start the Python helpers (KittenTTS voice, NCERT textbook search) alongside
// us if the venv is set up and nothing is already listening on their ports.
const PYTHON = resolve(ROOT_DIR, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
const children = [];
process.on('exit', () => children.forEach((c) => c.kill()));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());

async function startPythonService({ name, args, healthUrl, env }) {
  if (process.env[`${name.toUpperCase()}_AUTOSTART`] === '0') return;
  try {
    if ((await fetch(healthUrl, { signal: AbortSignal.timeout(1500) })).ok) return; // already running
  } catch {}
  if (!existsSync(PYTHON)) {
    console.log(`[${name}] Python venv not set up (no .venv), so ${name} is off. See README.`);
    return;
  }
  const child = spawn(PYTHON, ['-u', ...args], { cwd: ROOT_DIR, stdio: ['ignore', 'inherit', 'pipe'], env: { ...process.env, ...env } });
  // Library warnings go to stderr; only surface lines that look like real errors.
  child.stderr.on('data', (d) => {
    const text = d.toString();
    if (/error|traceback/i.test(text)) process.stderr.write(`[${name}] ${text}`);
  });
  child.on('exit', (code) => code && console.error(`[${name}] exited with code ${code}`));
  children.push(child);
}

startPythonService({ name: 'tts', args: ['tts_server.py'], healthUrl: `${TTS_URL}/health`, env: { KITTEN_PORT: new URL(TTS_URL).port || '5005' } });
startPythonService({ name: 'ncert', args: ['-m', 'ncert.server'], healthUrl: `${NCERT_URL}/health`, env: { NCERT_PORT: new URL(NCERT_URL).port || '5006' } });
