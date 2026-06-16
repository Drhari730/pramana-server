/* ============================================================
   Pramana database layer.
   Production: real Postgres via DATABASE_URL.
   Local testing: in-memory DB when DATABASE_URL is absent.
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

function clone(o) { return JSON.parse(JSON.stringify(o)); }

const T = { users: [], projects: [], members: [], invites: [] };

async function localQuery(text, params = []) {
  const s = text.replace(/\s+/g, ' ').trim();

  if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) return [];

  if (s === 'SELECT id,email,name FROM users WHERE id=$1')
    return T.users.filter(u => u.id === params[0]).map(u => ({ id: u.id, email: u.email, name: u.name }));
  if (s === 'SELECT id FROM users WHERE email=$1')
    return T.users.filter(u => u.email === params[0]).map(u => ({ id: u.id }));
  if (s === 'SELECT id,email,name FROM users WHERE email=$1')
    return T.users.filter(u => u.email === params[0]).map(u => ({ id: u.id, email: u.email, name: u.name }));
  if (s === 'SELECT id,email,name,password_hash FROM users WHERE email=$1')
    return T.users.filter(u => u.email === params[0]).map(u => clone(u));
  if (s.startsWith('INSERT INTO users')) {
    const cols = s.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c => c.trim());
    const row = {};
    cols.forEach((c, i) => { row[c] = params[i]; });
    T.users.push(row);
    return [];
  }

  if (s.startsWith('INSERT INTO projects')) {
    const cols = s.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c => c.trim());
    const row = { version: 1, updated_at: new Date().toISOString() };
    cols.forEach((c, i) => { row[c] = params[i]; });
    if (typeof row.data === 'string') row.data = JSON.parse(row.data);
    T.projects.push(row);
    return [];
  }
  if (s.startsWith('SELECT p.id,p.title,p.version,p.updated_at,m.role')) {
    return T.members.filter(m => m.user_id === params[0]).map(m => {
      const p = T.projects.find(x => x.id === m.project_id);
      return {
        id: p.id,
        title: p.title,
        version: p.version,
        updated_at: p.updated_at,
        role: m.role,
        member_count: T.members.filter(x => x.project_id === p.id).length
      };
    });
  }
  if (s === 'SELECT id,title,data,version,updated_at,updated_by FROM projects WHERE id=$1')
    return T.projects.filter(p => p.id === params[0]).map(p => clone(p));
  if (s === 'SELECT version FROM projects WHERE id=$1')
    return T.projects.filter(p => p.id === params[0]).map(p => ({ version: p.version }));
  if (s === 'SELECT title FROM projects WHERE id=$1')
    return T.projects.filter(p => p.id === params[0]).map(p => ({ title: p.title }));
  if (s.startsWith('UPDATE projects SET data=')) {
    const p = T.projects.find(x => x.id === params[4]);
    if (p) {
      p.data = JSON.parse(params[0]);
      p.version = params[1];
      p.updated_by = params[2];
      p.title = params[3];
      p.updated_at = new Date().toISOString();
    }
    return [];
  }
  if (s === 'DELETE FROM projects WHERE id=$1') {
    T.projects = T.projects.filter(p => p.id !== params[0]);
    T.members = T.members.filter(m => m.project_id !== params[0]);
    T.invites = T.invites.filter(i => i.project_id !== params[0]);
    return [];
  }

  if (s === 'SELECT role FROM members WHERE project_id=$1 AND user_id=$2')
    return T.members.filter(m => m.project_id === params[0] && m.user_id === params[1]).map(m => ({ role: m.role }));
  if (s.startsWith('INSERT INTO members')) {
    const exists = T.members.find(m => m.project_id === params[0] && m.user_id === params[1]);
    if (!exists) T.members.push({ project_id: params[0], user_id: params[1], role: params[2] });
    return [];
  }
  if (s.startsWith('SELECT u.id,u.email,u.name,m.role FROM members')) {
    return T.members.filter(m => m.project_id === params[0]).map(m => {
      const u = T.users.find(x => x.id === m.user_id);
      return { id: u.id, email: u.email, name: u.name, role: m.role };
    });
  }
  if (s === 'DELETE FROM members WHERE project_id=$1 AND user_id=$2') {
    T.members = T.members.filter(m => !(m.project_id === params[0] && m.user_id === params[1]));
    return [];
  }

  if (s === 'SELECT token,project_id,role FROM invites WHERE email=$1 AND accepted=false')
    return T.invites.filter(i => i.email === params[0] && !i.accepted).map(clone);
  if (s.startsWith('INSERT INTO invites')) {
    T.invites.push({
      token: params[0],
      project_id: params[1],
      email: params[2],
      role: params[3],
      invited_by: params[4],
      accepted: false
    });
    return [];
  }
  if (s === 'UPDATE invites SET accepted=true WHERE token=$1') {
    const i = T.invites.find(x => x.token === params[0]);
    if (i) i.accepted = true;
    return [];
  }
  if (s === 'SELECT project_id,role FROM invites WHERE token=$1')
    return T.invites.filter(i => i.token === params[0]).map(i => ({ project_id: i.project_id, role: i.role }));
  if (s.startsWith('SELECT email,role FROM invites WHERE project_id=$1'))
    return T.invites.filter(i => i.project_id === params[0] && !i.accepted).map(i => ({ email: i.email, role: i.role }));

  throw new Error('Local dev DB does not handle query: ' + s);
}

let _query = process.env.DATABASE_URL
  ? async (text, params) => {
      const res = await getPool().query(text, params);
      return res.rows;
    }
  : localQuery;

function setQueryImpl(fn) { _query = fn; }
async function q(text, params) { return _query(text, params); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT,
  password_hash TEXT,
  google_id     TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  title       TEXT,
  owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
  data        JSONB NOT NULL DEFAULT '{}',
  version     BIGINT NOT NULL DEFAULT 1,
  updated_at  TIMESTAMPTZ DEFAULT now(),
  updated_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE IF NOT EXISTS members (
  project_id  TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'reviewer',
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
`;

async function initSchema() {
  if (!process.env.DATABASE_URL) {
    console.warn('DATABASE_URL is not set. Using local in-memory DB for development only.');
    return;
  }
  await getPool().query(SCHEMA);
}

module.exports = { q, initSchema, setQueryImpl, getPool, SCHEMA };
