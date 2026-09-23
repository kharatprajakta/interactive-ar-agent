// Email + password accounts. Passwords are hashed with scrypt; a login gets a
// random session token, kept in an HttpOnly cookie (only its hash is stored).
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { db } from './db.js';

const scryptAsync = promisify(scrypt);
const COOKIE = 'hc_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 8; // failed logins per email per window
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const fails = new Map(); // email or "invite:<ip>" -> { count, since }

// Optional invite codes (comma-separated). When set, signing up needs one, so a
// shared link doesn't let just anyone create an account and use your machine.
const INVITE_CODES = (process.env.INVITE_CODE || '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
export const inviteRequired = () => INVITE_CODES.length > 0;

function tooManyFails(key) {
  const f = fails.get(key);
  return f && Date.now() - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILS;
}

function recordFail(key) {
  const f = fails.get(key);
  const entry = f && Date.now() - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: Date.now() };
  entry.count++;
  fails.set(key, entry);
}

/** Constant-time check against every configured code. */
function validInvite(code) {
  const given = sha256(String(code || '').trim());
  let ok = false;
  for (const c of INVITE_CODES) ok = timingSafeEqual(Buffer.from(sha256(c), 'hex'), Buffer.from(given, 'hex')) || ok;
  return ok;
}

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email });

function cleanEmail(email) {
  email = String(email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) throw new AuthError('Please enter a valid email address.');
  return email;
}

export function cleanName(name) {
  name = String(name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) throw new AuthError('Please tell us your name (up to 40 characters).');
  return name;
}

export async function signUp({ name, email, password, invite }, ip = '') {
  if (inviteRequired()) {
    const key = `invite:${ip}`;
    if (tooManyFails(key)) throw new AuthError('Too many attempts. Please wait a few minutes and try again.', 429);
    if (!validInvite(invite)) {
      recordFail(key);
      throw new AuthError("That invite code isn't right. Ask whoever shared this link for one.", 403);
    }
  }
  name = cleanName(name);
  email = cleanEmail(email);
  if (typeof password !== 'string' || password.length < 8) throw new AuthError('Use a password with at least 8 characters.');
  if (password.length > 200) throw new AuthError('That password is too long.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AuthError('An account with this email already exists. Try signing in.', 409);
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (email, name, pass_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, name, await hashPassword(password), Date.now());
  return { id: Number(lastInsertRowid), name, email };
}

export async function logIn({ email, password }) {
  email = cleanEmail(email);
  if (tooManyFails(email)) throw new AuthError('Too many attempts. Please wait a few minutes and try again.', 429);
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = user && typeof password === 'string' && (await verifyPassword(password, user.pass_hash));
  if (!ok) {
    recordFail(email);
    throw new AuthError("That email and password don't match.", 401);
  }
  fails.delete(email);
  return publicUser(user);
}

export function renameUser(userId, name) {
  name = cleanName(name);
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
  return name;
}

/** Start a session; returns the Set-Cookie header value. */
export function createSession(userId, secure) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = SESSION_DAYS * 24 * 3600;
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), userId, Date.now() + maxAge * 1000);
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

function tokenFrom(req) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([\\w-]+)`));
  return match?.[1] || null;
}

/** The signed-in user for a request, or null. */
export function userFromRequest(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const row = db
    .prepare('SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE token_hash = ? AND expires_at > ?')
    .get(sha256(token), Date.now());
  return row ? publicUser(row) : null;
}

/** End the request's session; returns the Set-Cookie header that clears it. */
export function endSession(req) {
  const token = tokenFrom(req);
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
