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
const emailState = {
  configured: false,
  lastEvent: null,
  lastError: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastRecipient: null
};
function hasRealValue(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return !!s && !s.includes('your-brevo') && !s.includes('example.com') && !s.includes('paste-a-long-random');
}
function emailConfigured() {
  const ok = hasRealValue(process.env.SMTP_HOST) &&
    hasRealValue(process.env.SMTP_PORT) &&
    hasRealValue(process.env.SMTP_USER) &&
    hasRealValue(process.env.SMTP_PASS) &&
    hasRealValue(process.env.SMTP_FROM);
  emailState.configured = ok;
  return ok;
}
function getMailer() {
  if (mailer) return mailer;
  if (!emailConfigured()) return null;   // email disabled if not configured
  mailer = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return mailer;
}
async function withTimeout(label, promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out after ' + ms + 'ms')), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
function queueEmail(label, recipient, fn) {
  emailState.lastAttemptAt = Date.now();
  emailState.lastRecipient = recipient;
  emailState.lastEvent = label + ' queued';
  setTimeout(async () => {
    try {
      await withTimeout(label, fn(), 20000);
      emailState.lastEvent = label + ' sent';
      emailState.lastError = null;
      emailState.lastSuccessAt = Date.now();
      console.log(label + ' sent');
    } catch (e) {
      emailState.lastEvent = label + ' failed';
      emailState.lastError = e.message;
      console.error(label + ' failed:', e.message);
    }
  }, 0);
}
function emailFrame({ pretitle, title, body, ctaLabel, ctaLink, note }) {
  return `<!doctype html>
  <html><body style="margin:0;padding:0;background:#f4f7fb;font-family:Segoe UI,Arial,sans-serif;color:#10213a">
    <div style="max-width:640px;margin:0 auto;padding:28px 16px">
      <div style="background:#ffffff;border:1px solid #d9e3f1;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(16,33,58,.08)">
        <div style="padding:22px 24px;background:linear-gradient(135deg,#0f8b8d,#3657d6);color:#fff">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:42px;height:42px;border-radius:12px;background:rgba(255,255,255,.18);display:flex;align-items:center;justify-content:center;font-size:24px;font-weight:700">P</div>
            <div>
              <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.82">${pretitle}</div>
              <div style="font-size:24px;font-weight:800;line-height:1.15;margin-top:2px">${title}</div>
            </div>
          </div>
        </div>
        <div style="padding:24px">
          <div style="font-size:15px;line-height:1.65;color:#24384f">${body}</div>
          ${ctaLink ? `<div style="margin:22px 0 10px"><a href="${ctaLink}" style="display:inline-block;background:#3657d6;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">${ctaLabel}</a></div>
          <div style="font-size:12px;line-height:1.5;color:#60748a;word-break:break-all">${ctaLink}</div>` : ''}
          ${note ? `<div style="margin-top:18px;font-size:12px;line-height:1.6;color:#60748a">${note}</div>` : ''}
        </div>
      </div>
    </div>
  </body></html>`;
}
async function sendInviteEmail(to, project, link, inviter) {
  const m = getMailer();
  if (!m) return { sent: false, reason: 'email-not-configured' };
  await m.sendMail({
    from: process.env.SMTP_FROM || 'Pramana <no-reply@pramana.app>',
    to,
    subject: `${inviter} invited you to a Pramana review: ${project}`,
    html: emailFrame({
      pretitle: 'Pramana Evidence Synthesis',
      title: 'You have been invited',
      body: `<p>${inviter} has invited you to collaborate on the systematic review <b>${project}</b>.</p>
             <p>Open the shared workspace below to join the review, screen studies, and work with the same live data.</p>`,
      ctaLabel: 'Open the review',
      ctaLink: link,
      note: 'If the button does not open, paste the link above into your browser.'
    })
  });
  return { sent: true };
}
async function sendResetEmail(to, link) {
  const m = getMailer();
  if (!m) return { sent: false, reason: 'email-not-configured' };
  await m.sendMail({
    from: process.env.SMTP_FROM || 'Pramana <no-reply@pramana.app>',
    to,
    subject: 'Reset your Pramana password',
    html: emailFrame({
      pretitle: 'Pramana Evidence Synthesis',
      title: 'Reset your password',
      body: `<p>You asked to reset your Pramana password.</p>
             <p>This link will let you choose a new password and expires in 1 hour.</p>`,
      ctaLabel: 'Choose a new password',
      ctaLink: link,
      note: 'If you did not request this, you can ignore this email.'
    })
  });
  return { sent: true };
}
async function sendWelcomeEmail(to, name) {
  const m = getMailer();
  if (!m) return { sent: false, reason: 'email-not-configured' };
  await m.sendMail({
    from: process.env.SMTP_FROM || 'Pramana <no-reply@pramana.app>',
    to,
    subject: 'Welcome to Pramana',
    html: emailFrame({
      pretitle: 'Pramana Evidence Synthesis',
      title: 'Your account is ready',
      body: `<p>Hello ${name || 'there'},</p>
             <p>Your Pramana account has been created successfully.</p>
             <p>You can now create reviews, invite collaborators, screen studies, extract data, and run meta-analysis from the same workspace.</p>`,
      ctaLabel: 'Open Pramana',
      ctaLink: APP_URL,
      note: 'This email confirms that account creation was successful.'
    })
  });
  return { sent: true };
}

/* ---------------- simple in-memory rate limiter ---------------- */
const _hits = new Map();   // key -> {count, resetAt}
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let e = _hits.get(key);
  if (!e || now > e.resetAt) { e = { count: 0, resetAt: now + windowMs }; _hits.set(key, e); }
  e.count++;
  return e.count <= max ? { ok: true } : { ok: false, retryAfter: Math.ceil((e.resetAt - now) / 1000) };
}
// periodic cleanup so the map doesn't grow forever
setInterval(() => { const now = Date.now(); for (const [k, v] of _hits) if (now > v.resetAt) _hits.delete(k); }, 10 * 60 * 1000).unref?.();

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
  let welcomeEmailQueued = false, emailError;
  if (emailConfigured()) {
    queueEmail('Welcome email', user.email, () => sendWelcomeEmail(user.email, user.name));
    welcomeEmailQueued = true;
  }
  res.json({ user, welcomeEmailQueued, emailError });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  // brute-force protection: max 8 attempts per email+IP per 15 min
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('login:' + (email||'').toLowerCase() + ':' + ip, 8, 15 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(rl.retryAfter/60)} minute(s).` });
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

/* ---- password reset ---- */
app.post('/api/auth/forgot', async (req, res) => {
  const { email } = req.body || {};
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('forgot:' + ip, 5, 15 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: 'Too many requests. Please wait a few minutes.' });
  const rows = await db.q('SELECT id,password_hash FROM users WHERE email=$1', [(email||'').toLowerCase()]);
  const u = rows[0];
  // Always respond the same way so we don't reveal whether an email exists.
  // Only actually create a reset if the account exists AND has a password (not google-only).
  let link = null;
  let emailQueued = false, emailError;
  if (u && u.password_hash) {
    const token = uid('rst_');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await db.q('INSERT INTO password_resets (token,user_id,expires_at) VALUES ($1,$2,$3)', [token, u.id, expires]);
    link = `${APP_URL}/?reset=${token}`;
    if (emailConfigured()) {
      queueEmail('Reset email', email, () => sendResetEmail(email, link));
      emailQueued = true;
    }
  }
  // If email isn't configured, return the link so it can be shown on screen (testing/no-Brevo case).
  const emailEnabled = emailConfigured();
  res.json({ ok: true, devLink: (!emailEnabled && link) ? link : undefined, emailQueued, emailError });
});

app.post('/api/auth/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!password || password.length < 6) return res.status(400).json({ error: 'Choose a password of at least 6 characters' });
  const rows = await db.q('SELECT user_id,expires_at,used FROM password_resets WHERE token=$1', [token]);
  const r = rows[0];
  if (!r || r.used || new Date(r.expires_at).getTime() < Date.now())
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Please request a new one.' });
  const hash = await bcrypt.hash(password, 10);
  await db.q('UPDATE users SET password_hash=$1 WHERE id=$2', [hash, r.user_id]);
  await db.q('UPDATE password_resets SET used=true WHERE token=$1', [token]);
  // log them in immediately
  const urows = await db.q('SELECT id,email,name FROM users WHERE id=$1', [r.user_id]);
  setAuthCookie(res, urows[0]);
  res.json({ ok: true, user: urows[0] });
});

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
  const rawPending = await db.q('SELECT email,role FROM invites WHERE project_id=$1 AND accepted=false', [req.params.id]);
  const seenPending = new Set();
  const pend = [];
  for (const invite of rawPending) {
    const key = `${invite.email}|${invite.role}`;
    if (seenPending.has(key)) continue;
    seenPending.add(key);
    pend.push(invite);
  }
  res.json({ members: rows, pending: pend });
}));

app.post('/api/projects/:id/invite', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (role !== 'owner' && role !== 'editor') return res.status(403).json({ error: 'Only owner/editor can invite' });
  const { email, role: inviteRole } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalizedEmail = email.toLowerCase();
  const normalizedRole = inviteRole || 'reviewer';
  const proj = await db.q('SELECT title FROM projects WHERE id=$1', [req.params.id]);
  const existingPending = await db.q('SELECT token FROM invites WHERE project_id=$1 AND email=$2 AND accepted=false', [req.params.id, normalizedEmail]);
  let token = existingPending[0] && existingPending[0].token;
  if (!token) {
    token = uid('inv_');
    await db.q('INSERT INTO invites (token,project_id,email,role,invited_by) VALUES ($1,$2,$3,$4,$5)',
      [token, req.params.id, normalizedEmail, normalizedRole, req.user.id]);
  }
  const existing = await db.q('SELECT id FROM users WHERE email=$1', [normalizedEmail]);
  if (existing[0]) {
    await db.q('INSERT INTO members (project_id,user_id,role) VALUES ($1,$2,$3) ON CONFLICT (project_id,user_id) DO NOTHING',
      [req.params.id, existing[0].id, normalizedRole]);
    await db.q('UPDATE invites SET accepted=true WHERE token=$1', [token]);
  }
  const link = `${APP_URL}/?invite=${token}`;
  let mail = { sent: false };
  if (!existing[0]) {
    if (emailConfigured()) {
      queueEmail('Invite email', normalizedEmail, () => sendInviteEmail(normalizedEmail, (proj[0]||{}).title || 'review', link, req.user.name || req.user.email));
      mail = { sent: true, queued: true };
    } else {
      mail = { sent: false, reason: 'email-not-configured' };
    }
  }
  res.json({
    ok: true,
    link,
    emailed: mail.sent,
    emailQueued: !!mail.queued,
    alreadyUser: !!existing[0],
    pendingAlreadyExists: !!existingPending[0],
    emailError: mail.sent ? undefined : mail.reason
  });
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
app.get('/api/config', (req, res) => res.json({ googleClientId: GOOGLE_CLIENT_ID, emailEnabled: emailConfigured() }));
app.get('/api/email/status', (req, res) => res.json({
  configured: emailConfigured(),
  lastEvent: emailState.lastEvent,
  lastError: emailState.lastError,
  lastAttemptAt: emailState.lastAttemptAt,
  lastSuccessAt: emailState.lastSuccessAt,
  lastRecipient: emailState.lastRecipient
}));
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
