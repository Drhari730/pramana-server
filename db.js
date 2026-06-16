/* ============================================================
   Pramana — database layer
   Uses real Postgres (pg) in production via DATABASE_URL.
   Schema is created on boot if it doesn't exist.
   ============================================================ */
const { Pool } = require('pg');

let pool = null;
function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
        ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

// Thin query helper. Allows swapping in a mock for tests.
let _query = async (text, params) => {
  const res = await getPool().query(text, params);
  return res.rows;
};
function setQueryImpl(fn) { _query = fn; }
async function q(text, params) { return _query(text, params); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,               -- null for google-only accounts
  google_id     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',   -- the whole project state (refs, effects, grade, etc.)
  version     BIGINT NOT NULL DEFAULT 1,     -- bumps on every save (optimistic concurrency)
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'reviewer',  -- owner | editor | reviewer
  added_at    TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  token       TEXT PRIMARY KEY,
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'reviewer',
  invited_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  accepted    BOOLEAN DEFAULT false
);

CREATE INDEX IF NOT EXISTS idx_members_user ON members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_email ON invites(email);

CREATE TABLE IF NOT EXISTS password_resets (
  token       TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);
`;

async function initSchema() {
  // pg can run multiple statements in one query call
  await getPool().query(SCHEMA);
}

module.exports = { q, initSchema, setQueryImpl, getPool, SCHEMA };
