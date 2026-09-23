// Hello Crew admin panel: who has signed up, how the crew is being used, and
// account controls (suspend, sign out everywhere, delete). Shares the app's
// PostgreSQL database. Meant for operators only: it binds to localhost (and
// in Docker is published on 127.0.0.1 only), never through the public tunnel.
// Conversation text is deliberately not exposed here, only counts and memory.
// Copyright (c) 2026 PacificAI. All rights reserved.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ready as dbReady, one, many, query } from '../lib/db.js';
import { sha256, safeEqual, tooManyFails, recordFail, clearFails, cookieValue } from '../lib/auth.js';
import { PERSONAS } from '../lib/personas.js';

const PORT = Number(process.env.ADMIN_PORT) || 3001;
const HOST = process.env.ADMIN_HOST || '127.0.0.1';
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), 'public');
const COOKIE = 'hc_admin';
const SESSION_HOURS = 12;

if (ADMIN_PASSWORD.length < 12) {
  console.error('[admin] Set ADMIN_PASSWORD (at least 12 characters) in .env to use the admin panel.');
  process.exit(1);
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readJson(req, limit = 10_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    return {};
  }
}

const isSecure = (req) => req.headers['x-forwarded-proto'] === 'https';

async function adminFromRequest(req) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const row = await one('SELECT username FROM admin_sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
  return row?.username || null;
}

const audit = (admin, action, target = null, detail = null) =>
  query('INSERT INTO admin_audit (admin, action, target, detail) VALUES ($1, $2, $3, $4)', [admin, action, target, detail]);

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------
async function stats() {
  const [totals, signups, byPersona, activeDays] = await Promise.all([
    one(`SELECT
           (SELECT COUNT(*) FROM users)::int AS users,
           (SELECT COUNT(*) FROM users WHERE disabled)::int AS suspended,
           (SELECT COUNT(*) FROM users WHERE last_seen_at > now() - interval '24 hours')::int AS active_24h,
           (SELECT COUNT(*) FROM users WHERE last_seen_at > now() - interval '7 days')::int AS active_7d,
           (SELECT COUNT(*) FROM messages)::int AS messages,
           (SELECT COUNT(*) FROM messages WHERE created_at > now() - interval '24 hours')::int AS messages_24h,
           (SELECT COUNT(*) FROM sessions WHERE expires_at > now())::int AS sessions`),
    many(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(n, 0)::int AS n
            FROM generate_series(current_date - 13, current_date, interval '1 day') AS d
            LEFT JOIN (SELECT created_at::date AS day, COUNT(*) AS n FROM users GROUP BY 1) s ON s.day = d::date
           ORDER BY d`),
    many(`SELECT persona, COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS users
            FROM messages WHERE role = 'user' AND created_at > now() - interval '30 days'
           GROUP BY persona ORDER BY n DESC`),
    many(`SELECT to_char(d, 'YYYY-MM-DD') AS day, COALESCE(n, 0)::int AS n
            FROM generate_series(current_date - 13, current_date, interval '1 day') AS d
            LEFT JOIN (SELECT created_at::date AS day, COUNT(*) AS n FROM messages WHERE role = 'user' GROUP BY 1) s ON s.day = d::date
           ORDER BY d`),
  ]);
  const names = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));
  return { totals, signups, activity: activeDays, byPersona: byPersona.map((r) => ({ ...r, name: names[r.persona] || r.persona })) };
}

async function listUsers(q) {
  const like = q ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  return many(
    `SELECT u.id, u.name, u.email, u.disabled, u.created_at, u.last_seen_at,
            COALESCE(m.n, 0)::int AS messages, m.last_at AS last_message_at,
            COALESCE(s.n, 0)::int AS sessions,
            COALESCE(jsonb_array_length(mem.data->'facts'), 0)::int AS facts,
            mem.data->>'language' AS language
       FROM users u
       LEFT JOIN (SELECT user_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM messages GROUP BY user_id) m ON m.user_id = u.id
       LEFT JOIN (SELECT user_id, COUNT(*) AS n FROM sessions WHERE expires_at > now() GROUP BY user_id) s ON s.user_id = u.id
       LEFT JOIN memory mem ON mem.user_id = u.id
      WHERE $1::text IS NULL OR u.name ILIKE $1 OR u.email ILIKE $1
      ORDER BY u.last_seen_at DESC NULLS LAST, u.created_at DESC
      LIMIT 500`,
    [like],
  );
}

async function userDetail(id) {
  const user = await one('SELECT id, name, email, disabled, created_at, last_seen_at FROM users WHERE id = $1', [id]);
  if (!user) return null;
  const [memory, personas, sessions] = await Promise.all([
    one('SELECT data, updated_at FROM memory WHERE user_id = $1', [id]),
    many(`SELECT persona, COUNT(*)::int AS messages, MAX(created_at) AS last_at
            FROM messages WHERE user_id = $1 GROUP BY persona ORDER BY last_at DESC`, [id]),
    one(`SELECT COUNT(*)::int AS active, MAX(created_at) AS last_login
           FROM sessions WHERE user_id = $1 AND expires_at > now()`, [id]),
  ]);
  const names = Object.fromEntries(PERSONAS.map((p) => [p.id, p.name]));
  return {
    user,
    memory: memory?.data || null,
    memoryUpdated: memory?.updated_at || null,
    personas: personas.map((p) => ({ ...p, name: names[p.persona] || p.persona })),
    sessions,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
async function handleApi(req, res, pathname) {
  if (pathname === '/api/login' && req.method === 'POST') {
    const ip = req.socket.remoteAddress || '';
    const key = `admin:${ip}`;
    if (tooManyFails(key)) return send(res, 429, { error: 'Too many attempts. Wait a few minutes.' });
    const { username, password } = await readJson(req);
    // Always compare both, so timing doesn't reveal which one was wrong.
    const ok = safeEqual(username || '', ADMIN_USERNAME) & safeEqual(password || '', ADMIN_PASSWORD);
    if (!ok) {
      recordFail(key);
      await audit(String(username || '').slice(0, 60) || '?', 'login_failed', null, ip);
      return send(res, 401, { error: 'Wrong username or password.' });
    }
    clearFails(key);
    const token = randomBytes(32).toString('base64url');
    await query('DELETE FROM admin_sessions WHERE expires_at < now()');
    await query(`INSERT INTO admin_sessions (token_hash, username, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`, [sha256(token), ADMIN_USERNAME, SESSION_HOURS]);
    await audit(ADMIN_USERNAME, 'login', null, ip);
    const cookie = `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_HOURS * 3600}${isSecure(req) ? '; Secure' : ''}`;
    return send(res, 200, { username: ADMIN_USERNAME }, undefined, { 'Set-Cookie': cookie });
  }

  const admin = await adminFromRequest(req);
  if (!admin) return send(res, 401, { error: 'Please sign in.' });
  // State-changing requests must come from our own page (custom header = no cross-site form posts).
  if (req.method !== 'GET' && req.headers['x-hello-crew-admin'] !== '1') return send(res, 403, { error: 'Forbidden' });

  if (pathname === '/api/me') return send(res, 200, { username: admin });
  if (pathname === '/api/logout' && req.method === 'POST') {
    const token = cookieValue(req, COOKIE);
    if (token) await query('DELETE FROM admin_sessions WHERE token_hash = $1', [sha256(token)]);
    return send(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (pathname === '/api/stats') return send(res, 200, await stats());
  if (pathname === '/api/users' && req.method === 'GET') {
    const q = new URL(req.url, 'http://x').searchParams.get('q')?.trim().slice(0, 100) || null;
    return send(res, 200, { users: await listUsers(q) });
  }
  if (pathname === '/api/audit') {
    return send(res, 200, { entries: await many('SELECT at, admin, action, target, detail FROM admin_audit ORDER BY id DESC LIMIT 200') });
  }

  const m = pathname.match(/^\/api\/users\/(\d+)(?:\/(suspend|unsuspend|revoke))?$/);
  if (m) {
    const id = Number(m[1]);
    const target = await one('SELECT id, email FROM users WHERE id = $1', [id]);
    if (!target) return send(res, 404, { error: 'No such user.' });
    const label = `${target.email} (#${id})`;
    if (!m[2] && req.method === 'GET') return send(res, 200, await userDetail(id));
    if (!m[2] && req.method === 'DELETE') {
      await query('DELETE FROM users WHERE id = $1', [id]); // cascades to sessions, messages, memory
      await audit(admin, 'delete_user', label);
      return send(res, 200, { ok: true });
    }
    if (m[2] && req.method === 'POST') {
      if (m[2] === 'suspend') {
        await query('UPDATE users SET disabled = TRUE WHERE id = $1', [id]);
        await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      } else if (m[2] === 'unsuspend') {
        await query('UPDATE users SET disabled = FALSE WHERE id = $1', [id]);
      } else {
        await query('DELETE FROM sessions WHERE user_id = $1', [id]);
      }
      await audit(admin, m[2] === 'revoke' ? 'sign_out_everywhere' : m[2], label);
      return send(res, 200, { ok: true });
    }
  }
  send(res, 404, { error: 'Not found' });
}

async function serveStatic(res, pathname) {
  if (pathname === '/') pathname = '/index.html';
  const file = resolve(PUBLIC_DIR, '.' + pathname);
  if (!file.startsWith(PUBLIC_DIR + sep)) return send(res, 403, 'Forbidden', 'text/plain');
  try {
    send(res, 200, await readFile(file), MIME[extname(file)] || 'application/octet-stream');
  } catch {
    send(res, 404, 'Not found', 'text/plain');
  }
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  try {
    if (pathname === '/healthz') {
      await query('SELECT 1');
      return send(res, 200, { ok: true });
    }
    if (pathname.startsWith('/api/')) return await handleApi(req, res, pathname);
    if (req.method === 'GET') return await serveStatic(res, pathname);
    send(res, 405, 'Method not allowed', 'text/plain');
  } catch (err) {
    console.error('[admin]', err);
    if (!res.headersSent) send(res, 500, { error: 'Internal error' });
    else res.end();
  }
});

await dbReady();
server.listen(PORT, HOST, () => console.log(`Hello Crew admin running at http://localhost:${PORT} (user "${ADMIN_USERNAME}")`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit());
