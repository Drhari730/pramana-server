/* ============================================================
   Pramana — collaborative SR backend (server.js)
   Endpoints:
     POST /api/auth/register   {email,name,password}
     POST /api/auth/login      {email,password}
     POST /api/auth/google     {credential}           (Google ID token)
     POST /api/auth/logout
     GET  /api/me
     GET  /api/projects                                list my projects
     POST /api/projects        {title,data}            create
     GET  /api/projects/:id                            load (must be member)
     PUT  /api/projects/:id    {data,version}          save (optimistic lock)
     DELETE /api/projects/:id                          owner only
     GET  /api/projects/:id/members
     POST /api/projects/:id/invite  {email,role}       owner/editor; emails a link
     POST /api/invites/accept  {token}                 join a project (must be logged in)
     DELETE /api/projects/:id/members/:userId          remove a member (owner)
   Static: serves the front-end (index.html) from ./public
   ============================================================ */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const app = express();
app.use(express.json({ limit: '12mb' }));   // project data can be large
app.use(cookieParser());

function uid(p) { return (p||'') + crypto.randomBytes(9).toString('base64url'); }

/* ---------------- auth helpers ---------------- */
function setAuthCookie(res, user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('pramana_token', token, {
    httpOnly: true, sameSite: 'lax', maxAge: 30*24*3600*1000,
    secure: process.env.NODE_ENV === 'production'
  });
}
async function currentUser(req) {
  const t = req.cookies && req.cookies.pramana_token;
  if (!t) return null;
  try {
    const { uid } = jwt.verify(t, JWT_SECRET);
    const rows = await db.q('SELECT id,email,name FROM users WHERE id=$1', [uid]);
    return rows[0] || null;
  } catch (e) { return null; }
}
function requireAuth(handler) {
  return async (req, res) => {
    const u = await currentUser(req);
    if (!u) return res.status(401).json({ error: 'Not logged in' });
    req.user = u;
    return handler(req, res);
  };
}
async function memberRole(projectId, userId) {
  const rows = await db.q('SELECT role FROM members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
  return rows[0] ? rows[0].role : null;
}

/* ---------------- email (Brevo via nodemailer SMTP) ---------------- */
const nodemailer = require('nodemailer');
let mailer = null;
function getMailer() {
  if (mailer) return mailer;
  if (!process.env.SMTP_HOST) return null;   // email disabled if not configured
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  return mailer;
}
async function sendInviteEmail(to, project, link, inviter) {
  const m = getMailer();
  if (!m) return { sent: false, reason: 'email-not-configured' };
  await m.sendMail({
    from: process.env.SMTP_FROM || 'Pramana <no-reply@pramana.app>',
    to,
    subject: `${inviter} invited you to a Pramana review: ${project}`,
    html: `<p>${inviter} has invited you to collaborate on the systematic review <b>${project}</b> in Pramana.</p>
           <p><a href="${link}" style="background:#4f46e5;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Open the review</a></p>
           <p>Or paste this link: ${link}</p>`
  });
  return { sent: true };
}

/* ---------------- AUTH ROUTES ---------------- */
app.post('/api/auth/register', async (req, res) => {
  const { email, name, password } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Email and a password of 6+ characters required' });
  const exists = await db.q('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (exists[0]) return res.status(409).json({ error: 'An account with this email already exists' });
  const id = uid('u_');
  const hash = await bcrypt.hash(password, 10);
  await db.q('INSERT INTO users (id,email,name,password_hash) VALUES ($1,$2,$3,$4)', [id, email.toLowerCase(), name || email.split('@')[0], hash]);
  const user = { id, email: email.toLowerCase(), name: name || email.split('@')[0] };
  await autoAcceptInvites(user);
  setAuthCookie(res, user);
  res.json({ user });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  const rows = await db.q('SELECT id,email,name,password_hash FROM users WHERE email=$1', [(email||'').toLowerCase()]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password' });
  const user = { id: u.id, email: u.email, name: u.name };
  setAuthCookie(res, user);
  res.json({ user });
});

app.post('/api/auth/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!credential || !GOOGLE_CLIENT_ID) return res.status(400).json({ error: 'Google sign-in not configured' });
  try {
    const { OAuth2Client } = require('google-auth-library');
    const client = new OAuth2Client(GOOGLE_CLIENT_ID);
    const ticket = await client.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    const email = (p.email || '').toLowerCase();
    let rows = await db.q('SELECT id,email,name FROM users WHERE email=$1', [email]);
    let user = rows[0];
    if (!user) {
      const id = uid('u_');
      await db.q('INSERT INTO users (id,email,name,google_id) VALUES ($1,$2,$3,$4)', [id, email, p.name || email.split('@')[0], p.sub]);
      user = { id, email, name: p.name || email.split('@')[0] };
    }
    await autoAcceptInvites(user);
    setAuthCookie(res, user);
    res.json({ user });
  } catch (e) { res.status(401).json({ error: 'Google verification failed' }); }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('pramana_token'); res.json({ ok: true }); });
app.get('/api/me', requireAuth(async (req, res) => res.json({ user: req.user })));

// when a user signs up/in, auto-join any pending invites for their email
async function autoAcceptInvites(user) {
  const invs = await db.q('SELECT token,project_id,role FROM invites WHERE email=$1 AND accepted=false', [user.email]);
  for (const inv of invs) {
    await db.q('INSERT INTO members (project_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (project_id,user_id) DO NOTHING', [inv.project_id, user.id, inv.role]);
    await db.q('UPDATE invites SET accepted=true WHERE token=$1', [inv.token]);
  }
}

/* ---------------- PROJECTS ---------------- */
app.get('/api/projects', requireAuth(async (req, res) => {
  const rows = await db.q(
    `SELECT p.id,p.title,p.version,p.updated_at,m.role,
            (SELECT count(*) FROM members mm WHERE mm.project_id=p.id) AS member_count
     FROM projects p JOIN members m ON m.project_id=p.id
     WHERE m.user_id=$1 ORDER BY p.updated_at DESC`, [req.user.id]);
  res.json({ projects: rows });
}));

app.post('/api/projects', requireAuth(async (req, res) => {
  const { title, data } = req.body || {};
  const id = uid('p_');
  await db.q('INSERT INTO projects (id,title,owner_id,data,updated_by) VALUES ($1,$2,$3,$4,$5)',
    [id, title || 'Untitled review', req.user.id, JSON.stringify(data || {}), req.user.id]);
  await db.q('INSERT INTO members (project_id,user_id,role) VALUES ($1,$2,$3)', [id, req.user.id, 'owner']);
  res.json({ id, version: 1 });
}));

app.get('/api/projects/:id', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Not a member of this project' });
  const rows = await db.q('SELECT id,title,data,version,updated_at,updated_by FROM projects WHERE id=$1', [req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'Project not found' });
  res.json({ project: rows[0], role });
}));

// optimistic-concurrency save: client sends the version it last loaded
app.put('/api/projects/:id', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Not a member' });
  const { data, version } = req.body || {};
  const cur = await db.q('SELECT version FROM projects WHERE id=$1', [req.params.id]);
  if (!cur[0]) return res.status(404).json({ error: 'Project not found' });
  if (version != null && Number(version) !== Number(cur[0].version)) {
    // someone else saved since this client loaded — tell it to refresh
    return res.status(409).json({ error: 'conflict', currentVersion: Number(cur[0].version) });
  }
  const newV = Number(cur[0].version) + 1;
  await db.q('UPDATE projects SET data=$1, version=$2, updated_at=now(), updated_by=$3, title=$4 WHERE id=$5',
    [JSON.stringify(data || {}), newV, req.user.id, (data && data.project && data.project.title) || 'Untitled review', req.params.id]);
  res.json({ version: newV, updated_at: new Date().toISOString() });
}));

app.delete('/api/projects/:id', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete' });
  await db.q('DELETE FROM projects WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------------- MEMBERS & INVITES ---------------- */
app.get('/api/projects/:id/members', requireAuth(async (req, res) => {
  if (!(await memberRole(req.params.id, req.user.id))) return res.status(403).json({ error: 'Not a member' });
  const rows = await db.q(
    `SELECT u.id,u.email,u.name,m.role FROM members m JOIN users u ON u.id=m.user_id WHERE m.project_id=$1`, [req.params.id]);
  const pend = await db.q('SELECT email,role FROM invites WHERE project_id=$1 AND accepted=false', [req.params.id]);
  res.json({ members: rows, pending: pend });
}));

app.post('/api/projects/:id/invite', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (role !== 'owner' && role !== 'editor') return res.status(403).json({ error: 'Only owner/editor can invite' });
  const { email, role: inviteRole } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const proj = await db.q('SELECT title FROM projects WHERE id=$1', [req.params.id]);
  // if the user already exists, add directly; also create an invite token for the link/email
  const token = uid('inv_');
  await db.q('INSERT INTO invites (token,project_id,email,role,invited_by) VALUES ($1,$2,$3,$4,$5)',
    [token, req.params.id, email.toLowerCase(), inviteRole || 'reviewer', req.user.id]);
  const existing = await db.q('SELECT id FROM users WHERE email=$1', [email.toLowerCase()]);
  if (existing[0]) {
    await db.q('INSERT INTO members (project_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (project_id,user_id) DO NOTHING',
      [req.params.id, existing[0].id, inviteRole || 'reviewer']);
    await db.q('UPDATE invites SET accepted=true WHERE token=$1', [token]);
  }
  const link = `${APP_URL}/?invite=${token}`;
  let mail = { sent: false };
  try { mail = await sendInviteEmail(email, (proj[0]||{}).title || 'review', link, req.user.name || req.user.email); } catch (e) { mail = { sent:false, reason:e.message }; }
  res.json({ ok: true, link, emailed: mail.sent, alreadyUser: !!existing[0] });
}));

app.post('/api/invites/accept', requireAuth(async (req, res) => {
  const { token } = req.body || {};
  const rows = await db.q('SELECT project_id,role FROM invites WHERE token=$1', [token]);
  if (!rows[0]) return res.status(404).json({ error: 'Invite not found or expired' });
  await db.q('INSERT INTO members (project_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (project_id,user_id) DO NOTHING',
    [rows[0].project_id, req.user.id, rows[0].role]);
  await db.q('UPDATE invites SET accepted=true WHERE token=$1', [token]);
  res.json({ ok: true, projectId: rows[0].project_id });
}));

app.delete('/api/projects/:id/members/:userId', requireAuth(async (req, res) => {
  if ((await memberRole(req.params.id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'Only owner' });
  await db.q('DELETE FROM members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  res.json({ ok: true });
}));

/* ---------------- config + static ---------------- */
app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, emailEnabled: !!process.env.SMTP_HOST }));
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

/* ---------------- boot ---------------- */
async function start() {
  await db.initSchema();
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log('Pramana server on :' + port));
}
if (require.main === module) start().catch(e => { console.error(e); process.exit(1); });

module.exports = { app, start };
