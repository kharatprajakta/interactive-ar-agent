// PostgreSQL store, shared by the app (server.js) and the admin panel
// (admin/server.js): user accounts, login sessions, each user's memory
// (chat history per character + a profile), and an admin audit log.
// Copyright (c) 2026 PacificAI. All rights reserved.
import pg from 'pg';

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://hellocrew:hellocrew@127.0.0.1:5433/hellocrew';

export const pool = new pg.Pool({
  connectionString: DATABASE_URL,
  max: Number(process.env.DB_POOL_SIZE) || 10,
  idleTimeoutMillis: 30_000,
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

export const query = (text, params) => pool.query(text, params);
export const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
export const many = async (text, params) => (await pool.query(text, params)).rows;

// Versioned schema changes. Append new entries; never edit an applied one.
const MIGRATIONS = [
  `CREATE TABLE users (
     id           BIGSERIAL PRIMARY KEY,
     email        TEXT NOT NULL,
     name         TEXT NOT NULL,
     pass_hash    TEXT NOT NULL,
     disabled     BOOLEAN NOT NULL DEFAULT FALSE,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_seen_at TIMESTAMPTZ
   );
   CREATE UNIQUE INDEX users_email_key ON users (lower(email));

   CREATE TABLE sessions (
     token_hash TEXT PRIMARY KEY,
     user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at TIMESTAMPTZ NOT NULL
   );
   CREATE INDEX sessions_user ON sessions (user_id);

   CREATE TABLE messages (
     id         BIGSERIAL PRIMARY KEY,
     user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     persona    TEXT NOT NULL,
     role       TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
     content    TEXT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX messages_by_user ON messages (user_id, persona, id);
   CREATE INDEX messages_created ON messages (created_at);

   -- One profile per user: { language, style, facts: [], study: {...} }
   CREATE TABLE memory (
     user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
     data       JSONB NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );

   CREATE TABLE admin_sessions (
     token_hash TEXT PRIMARY KEY,
     username   TEXT NOT NULL,
     expires_at TIMESTAMPTZ NOT NULL
   );

   CREATE TABLE admin_audit (
     id        BIGSERIAL PRIMARY KEY,
     at        TIMESTAMPTZ NOT NULL DEFAULT now(),
     admin     TEXT NOT NULL,
     action    TEXT NOT NULL,
     target    TEXT,
     detail    TEXT
   );`,

  // 2: invite codes and settings, managed from the admin panel.
  `CREATE TABLE invite_codes (
     id           BIGSERIAL PRIMARY KEY,
     code         TEXT NOT NULL,
     label        TEXT NOT NULL DEFAULT '',
     max_uses     INT CHECK (max_uses IS NULL OR max_uses > 0),
     uses         INT NOT NULL DEFAULT 0,
     expires_at   TIMESTAMPTZ,
     disabled     BOOLEAN NOT NULL DEFAULT FALSE,
     created_by   TEXT NOT NULL,
     created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ
   );
   CREATE UNIQUE INDEX invite_codes_code_key ON invite_codes (lower(code));
   ALTER TABLE users ADD COLUMN invite_code_id BIGINT REFERENCES invite_codes(id) ON DELETE SET NULL;

   -- Small key/value settings, e.g. signup_mode = invite | open | closed
   CREATE TABLE settings (
     key        TEXT PRIMARY KEY,
     value      TEXT NOT NULL,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );`,
];

/** Bring the schema up to date. Safe to call from several processes at once. */
export async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727274)'); // one migrator at a time
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (version INT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    const { rows } = await client.query('SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations');
    for (let v = rows[0].v; v < MIGRATIONS.length; v++) {
      await client.query('BEGIN');
      try {
        await client.query(MIGRATIONS[v]);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [v + 1]);
        await client.query('COMMIT');
        console.log(`[db] applied migration ${v + 1}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    client.release();
  }
}

/** Wait for Postgres (it may still be starting), then migrate. */
export async function ready({ attempts = 30 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await migrate();
      return;
    } catch (err) {
      if (i >= attempts || !/ECONNREFUSED|ENOTFOUND|starting up|EAI_AGAIN|timeout/i.test(err.message)) throw err;
      console.log(`[db] waiting for Postgres (${err.message})…`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
