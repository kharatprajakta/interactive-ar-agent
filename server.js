// Zero-dependency web server: serves the AR front end from ./public and
// proxies chat requests to a local Ollama instance, streaming tokens back.
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const OLLAMA_URL = (process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/$/, '');
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const TTS_URL = (process.env.TTS_URL || 'http://127.0.0.1:5005').replace(/\/$/, '');
const MAX_HISTORY = 20;
const ROOT_DIR = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = resolve(ROOT_DIR, 'public');

const SYSTEM_PROMPT =
  process.env.SYSTEM_PROMPT ||
  `You are Nova, a friendly, curious little robot companion who appears in the user's room through augmented reality.
Everything you say is spoken aloud by a text-to-speech voice, so:
- Keep replies short and conversational: usually 1-3 sentences.
- Never use markdown, bullet points, code blocks, emojis, or URLs.
- Write numbers and symbols the way they should be spoken.
Be warm and playful, but genuinely helpful. If you don't know something, say so.`;

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
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
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

async function ttsHealth() {
  try {
    const r = await fetch(`${TTS_URL}/health`, { signal: AbortSignal.timeout(2000) });
    return await r.json();
  } catch {
    return { ok: false };
  }
}

async function handleHealth(res) {
  const tts = await ttsHealth();
  try {
    const r = await fetch(`${OLLAMA_URL}/api/tags`);
    const { models = [] } = await r.json();
    const names = models.map((m) => m.name);
    const hasModel = names.includes(MODEL) || names.includes(`${MODEL}:latest`);
    sendJson(res, 200, {
      ok: hasModel,
      model: MODEL,
      models: names,
      tts,
      error: hasModel ? null : `Model "${MODEL}" isn't downloaded yet. Run: ollama pull ${MODEL}`,
    });
  } catch {
    sendJson(res, 200, {
      ok: false,
      model: MODEL,
      models: [],
      tts,
      error: `Can't reach Ollama at ${OLLAMA_URL}. Start it with: ollama serve`,
    });
  }
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

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendText(res, 400, 'Invalid JSON body');
  }

  const messages = (Array.isArray(body.messages) ? body.messages : [])
    .filter((m) => (m?.role === 'user' || m?.role === 'assistant') && typeof m.content === 'string')
    .slice(-MAX_HISTORY);
  if (!messages.length) return sendText(res, 400, 'No messages provided');

  // Stop generating if the browser goes away (e.g. user interrupts).
  const controller = new AbortController();
  res.on('close', () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: true,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        options: { temperature: 0.7 },
      }),
      signal: controller.signal,
    });
  } catch {
    return sendText(res, 502, `Can't reach Ollama at ${OLLAMA_URL}. Is it running? (ollama serve)`);
  }

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => '');
    const hint = upstream.status === 404 ? ` Try: ollama pull ${MODEL}` : '';
    return sendText(res, 502, `Ollama error ${upstream.status}: ${detail}${hint}`);
  }

  res.writeHead(200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });

  // Ollama streams newline-delimited JSON; forward just the text tokens.
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        const data = JSON.parse(line);
        if (data.error) throw new Error(data.error);
        if (data.message?.content) res.write(data.message.content);
      }
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      console.error('Stream error:', err.message);
      res.write(`\n[error: ${err.message}]`);
    }
  }
  res.end();
}

async function handler(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
    if (pathname === '/api/tts' && req.method === 'POST') return await handleTts(req, res);
    if (pathname === '/api/health' && req.method === 'GET') return await handleHealth(res);
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(req, res);
    sendText(res, 405, 'Method not allowed');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) sendText(res, 500, 'Internal server error');
    else res.end();
  }
}

// Camera + WebXR need a secure context. localhost counts as secure; for a phone
// on your LAN, provide a certificate via SSL_KEY / SSL_CERT (or use a tunnel).
const useHttps = process.env.SSL_KEY && process.env.SSL_CERT;
const server = useHttps
  ? https.createServer(
      { key: readFileSync(process.env.SSL_KEY), cert: readFileSync(process.env.SSL_CERT) },
      handler,
    )
  : http.createServer(handler);

server.listen(PORT, HOST, () => {
  const scheme = useHttps ? 'https' : 'http';
  console.log(`AR agent running at ${scheme}://localhost:${PORT}`);
  console.log(`Using Ollama model "${MODEL}" at ${OLLAMA_URL}`);
});

// Start the KittenTTS service alongside us if its Python venv is set up and
// nothing is already listening. Without it, the browser's built-in voice is used.
async function startTtsService() {
  if (process.env.TTS_AUTOSTART === '0' || (await ttsHealth()).ok) return;
  const python = resolve(ROOT_DIR, process.platform === 'win32' ? '.venv/Scripts/python.exe' : '.venv/bin/python');
  if (!existsSync(python)) {
    console.log('KittenTTS not set up (no .venv); using the browser voice. See README to enable it.');
    return;
  }
  const child = spawn(python, ['-u', 'tts_server.py'], {
    cwd: ROOT_DIR,
    stdio: ['ignore', 'inherit', 'pipe'],
    env: { ...process.env, KITTEN_PORT: new URL(TTS_URL).port || '5005' },
  });
  // Library warnings go to stderr; only surface lines that look like real errors.
  child.stderr.on('data', (d) => {
    const text = d.toString();
    if (/error|traceback/i.test(text)) process.stderr.write(`[tts] ${text}`);
  });
  child.on('exit', (code) => code && console.error(`[tts] exited with code ${code}`));
  const stop = () => child.kill();
  process.on('exit', stop);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());
}
startTtsService();
