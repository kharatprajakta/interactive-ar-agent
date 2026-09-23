// Email + password accounts. Passwords are hashed with scrypt; a login gets a
// random session token, kept in an HttpOnly cookie (only its hash is stored).
// Copyright (c) 2026 PacificAI. All rights reserved.
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { one, query } from './db.js';

const scryptAsync = promisify(scrypt);
const COOKIE = 'hc_session';
const SESSION_DAYS = 30;
const MAX_FAILS = 8; // failed attempts per key per window
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const SEEN_EVERY_MS = 5 * 60 * 1000; // how often to refresh users.last_seen_at
const fails = new Map(); // email or "invite:<ip>" -> { count, since }

// Optional invite codes (comma-separated). When set, signing up needs one, so a
// shared link doesn't let just anyone create an account and use your machine.
const INVITE_CODES = (process.env.INVITE_CODE || '')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);
export const inviteRequired = () => INVITE_CODES.length > 0;

export class AuthError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, key] = String(stored).split('$');
  if (!salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(String(password), Buffer.from(salt, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

/** Constant-time string comparison (via fixed-length hashes). */
export function safeEqual(a, b) {
  return timingSafeEqual(Buffer.from(sha256(String(a)), 'hex'), Buffer.from(sha256(String(b)), 'hex'));
}

export function tooManyFails(key) {
  const f = fails.get(key);
  return f && Date.now() - f.since < FAIL_WINDOW_MS && f.count >= MAX_FAILS;
}

export function recordFail(key) {
  const f = fails.get(key);
  const entry = f && Date.now() - f.since < FAIL_WINDOW_MS ? f : { count: 0, since: Date.now() };
  entry.count++;
  fails.set(key, entry);
}

export const clearFails = (key) => fails.delete(key);

function validInvite(code) {
  let ok = false;
  for (const c of INVITE_CODES) ok = safeEqual(c, String(code || '').trim()) || ok;
  return ok;
}

const publicUser = (u) => ({ id: Number(u.id), name: u.name, email: u.email });

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
  const passHash = await hashPassword(password);
  try {
    const row = await one('INSERT INTO users (email, name, pass_hash) VALUES ($1, $2, $3) RETURNING *', [email, name, passHash]);
    return publicUser(row);
  } catch (err) {
    if (err.code === '23505') throw new AuthError('An account with this email already exists. Try signing in.', 409);
    throw err;
  }
}

export async function logIn({ email, password }) {
  email = cleanEmail(email);
  if (tooManyFails(email)) throw new AuthError('Too many attempts. Please wait a few minutes and try again.', 429);
  const user = await one('SELECT * FROM users WHERE lower(email) = $1', [email]);
  const ok = user && typeof password === 'string' && (await verifyPassword(password, user.pass_hash));
  if (!ok) {
    recordFail(email);
    throw new AuthError("That email and password don't match.", 401);
  }
  if (user.disabled) throw new AuthError('This account has been suspended. Please contact the person who invited you.', 403);
  clearFails(email);
  return publicUser(user);
}

export async function renameUser(userId, name) {
  name = cleanName(name);
  await query('UPDATE users SET name = $1 WHERE id = $2', [name, userId]);
  return name;
}

/** Start a session; returns the Set-Cookie header value. */
export async function createSession(userId, secure) {
  const token = randomBytes(32).toString('base64url');
  const maxAge = SESSION_DAYS * 24 * 3600;
  await query('DELETE FROM sessions WHERE expires_at < now()');
  await query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(secs => $3))`, [sha256(token), userId, maxAge]);
  await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

export function cookieValue(req, name) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${name}=([\\w-]+)`));
  return match?.[1] || null;
}

/** The signed-in (and not suspended) user for a request, or null. */
export async function userFromRequest(req) {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  const row = await one(
    `SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id
      WHERE token_hash = $1 AND expires_at > now() AND NOT users.disabled`,
    [sha256(token)],
  );
  if (!row) return null;
  if (!row.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > SEEN_EVERY_MS) {
    query('UPDATE users SET last_seen_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }
  return publicUser(row);
}

/** End the request's session; returns the Set-Cookie header that clears it. */
export async function endSession(req) {
  const token = cookieValue(req, COOKIE);
  if (token) await query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}
