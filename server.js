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
     POST /api/ai/generate     {prompt,maxTok,model}   server-side AI proxy
     POST /api/projects/:id/ai/screen {stage,refId}     server-side Viveka screening
     POST /api/projects/:id/ai/extract {refId,fields}   server-side Viveka extraction
   Static: serves the front-end (index.html) from ./public
   ============================================================ */
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { PDFParse } = require('pdf-parse');
const { createWorker } = require('tesseract.js');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-change-me';
const APP_URL = process.env.APP_URL || 'http://localhost:3000';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const AI_KEYS = {
  'gemini-flash': process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '',
  'gpt4o-mini': process.env.OPENAI_API_KEY || '',
  'claude-haiku': process.env.ANTHROPIC_API_KEY || '',
  deepseek: process.env.DEEPSEEK_API_KEY || '',
  'zai-glm': process.env.ZAI_API_KEY || ''
};
function aiServerEnabled() {
  return Object.values(AI_KEYS).some(hasRealValue);
}

const app = express();
app.use(express.json({ limit: '12mb' }));   // project data can be large
app.use(cookieParser());
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 18 * 1024 * 1024 }
});

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
    const rows = await db.q('SELECT id,email,name,ai_credits FROM users WHERE id=$1', [uid]);
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
async function requireAuthMiddleware(req, res, next) {
  const u = await currentUser(req);
  if (!u) return res.status(401).json({ error: 'Not logged in' });
  req.user = u;
  next();
}
async function memberRole(projectId, userId) {
  const rows = await db.q('SELECT role FROM members WHERE project_id=$1 AND user_id=$2', [projectId, userId]);
  return rows[0] ? rows[0].role : null;
}
function publicUser(u) {
  if (!u) return u;
  return { id: u.id, email: u.email, name: u.name, aiCredits: Number(u.ai_credits ?? u.aiCredits ?? 0), isAdmin: isAdmin(u) };
}
function adminEmails() {
  return String(process.env.ADMIN_EMAILS || 'pramana.ai.srma@gmail.com')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}
function isAdmin(user) {
  return !!(user && adminEmails().includes(String(user.email || '').toLowerCase()));
}
function requireAdmin(handler) {
  return requireAuth(async (req, res) => {
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Admin only' });
    return handler(req, res);
  });
}
async function aiBalance(userId) {
  const rows = await db.q('SELECT ai_credits FROM users WHERE id=$1', [userId]);
  return Number((rows[0] && rows[0].ai_credits) || 0);
}
async function chargeAICredits(userId, credits, feature, model, projectId) {
  const cost = Math.max(1, Number(credits) || 1);
  const bal = await aiBalance(userId);
  if (bal < cost) {
    const err = new Error(`Not enough Viveka AI credits. You have ${bal}, need ${cost}. Manual work is still free.`);
    err.status = 402;
    err.balance = bal;
    throw err;
  }
  const rows = await db.q('UPDATE users SET ai_credits=ai_credits-$1 WHERE id=$2 AND ai_credits >= $1 RETURNING ai_credits', [cost, userId]);
  if (!rows[0]) {
    const err = new Error('Not enough Viveka AI credits. Manual work is still free.');
    err.status = 402;
    throw err;
  }
  await db.q('INSERT INTO ai_usage (id,user_id,project_id,feature,model,credits) VALUES ($1,$2,$3,$4,$5,$6)',
    [uid('au_'), userId, projectId || null, feature, model || '', cost]);
  return Number(rows[0].ai_credits || 0);
}

/* ---------------- email (Brevo via nodemailer SMTP) ---------------- */
const nodemailer = require('nodemailer');
let mailer = null;
const emailState = {
  configured: false,
  transport: null,
  lastEvent: null,
  lastError: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastRecipient: null
};
function hasRealValue(v) {
  if (!v) return false;
  const s = String(v).trim().toLowerCase();
  return !!s && !s.includes('your-brevo') && !s.includes('example.com') && !s.includes('paste-a-long-random') && !s.includes('your-api-key');
}
function apiEmailConfigured() {
  return hasRealValue(process.env.BREVO_API_KEY) && hasRealValue(process.env.SMTP_FROM);
}
function smtpEmailConfigured() {
  return hasRealValue(process.env.SMTP_HOST) &&
    hasRealValue(process.env.SMTP_PORT) &&
    hasRealValue(process.env.SMTP_USER) &&
    hasRealValue(process.env.SMTP_PASS) &&
    hasRealValue(process.env.SMTP_FROM);
}
function emailConfigured() {
  const ok = apiEmailConfigured() || smtpEmailConfigured();
  emailState.configured = ok;
  emailState.transport = apiEmailConfigured() ? 'brevo-api' : (smtpEmailConfigured() ? 'smtp' : null);
  return ok;
}

/* ---------------- server-side AI provider proxy ---------------- */
function aiModelMeta(model) {
  return {
    'gemini-flash': {
      key: AI_KEYS['gemini-flash'],
      label: 'Gemini 2.0 Flash'
    },
    'gpt4o-mini': {
      key: AI_KEYS['gpt4o-mini'],
      label: 'GPT-4o mini',
      endpoint: 'https://api.openai.com/v1/chat/completions',
      providerModel: 'gpt-4o-mini'
    },
    'claude-haiku': {
      key: AI_KEYS['claude-haiku'],
      label: 'Claude Haiku'
    },
    deepseek: {
      key: AI_KEYS.deepseek,
      label: 'DeepSeek Chat',
      endpoint: 'https://api.deepseek.com/v1/chat/completions',
      providerModel: 'deepseek-chat'
    },
    'zai-glm': {
      key: AI_KEYS['zai-glm'],
      label: 'Z.ai GLM-4',
      endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
      providerModel: 'glm-4-flash'
    }
  }[model];
}
function configuredAIModels() {
  return Object.keys(AI_KEYS).filter(k => hasRealValue(AI_KEYS[k]));
}
async function serverLLM(prompt, maxTok, model) {
  const meta = aiModelMeta(model);
  if (!meta) throw new Error('Unsupported AI model');
  if (!hasRealValue(meta.key)) throw new Error(meta.label + ' is not configured on the server');
  const maxOutputTokens = Math.max(32, Math.min(Number(maxTok) || 900, 2500));
  let r, d, txt;
  if (model === 'gemini-flash') {
    r = await withTimeout('Gemini request', fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + encodeURIComponent(meta.key), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens, temperature: 0.2 }
      })
    }), 60000);
    d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && d.error.message) || 'Gemini server error');
    txt = d.candidates && d.candidates[0] && d.candidates[0].content &&
      d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
      d.candidates[0].content.parts[0].text;
  } else if (model === 'claude-haiku') {
    r = await withTimeout('Claude request', fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': meta.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-3-5-haiku-20241022', max_tokens: maxOutputTokens, messages: [{ role: 'user', content: prompt }] })
    }), 60000);
    d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && d.error.message) || 'Claude server error');
    txt = d.content && d.content[0] && d.content[0].text;
  } else {
    r = await withTimeout('AI provider request', fetch(meta.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + meta.key },
      body: JSON.stringify({ model: meta.providerModel, max_tokens: maxOutputTokens, temperature: 0.2, messages: [{ role: 'user', content: prompt }] })
    }), 60000);
    d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) throw new Error((d.error && d.error.message) || 'AI provider server error');
    txt = d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
  }
  if (!txt) throw new Error('Empty AI response');
  return txt;
}

function parseAIJSON(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(s); } catch (e) {}
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error('AI returned non-JSON output');
}
function normDecision(v) {
  const s = String(v || '').toLowerCase();
  if (s.includes('inc')) return 'include';
  if (s.includes('may') || s.includes('unclear') || s.includes('border')) return 'maybe';
  if (s.includes('exc')) return 'exclude';
  return 'maybe';
}
function safeText(v, limit) {
  const s = String(v || '').replace(/\s+/g, ' ').trim();
  return limit ? s.slice(0, limit) : s;
}
function reviewContext(project) {
  const p = project || {};
  return [
    `REVIEW TYPE: ${safeText(p.type || p.reviewTypeId || 'Systematic review')}`,
    `FRAMEWORK: ${safeText(p.framework || 'PICO/PCC as configured')}`,
    `TITLE: ${safeText(p.title || '')}`,
    `QUESTION: ${safeText(p.question || '')}`,
    `AXIS 1 / POPULATION: ${safeText(p.p || 'any')}`,
    `AXIS 2 / INTERVENTION-CONCEPT-EXPOSURE: ${safeText(p.i || 'any')}`,
    `AXIS 3 / COMPARATOR-CONTEXT: ${safeText(p.c || 'any')}`,
    `AXIS 4 / OUTCOME: ${safeText(p.o || 'any')}`,
    `INCLUSION CRITERIA: ${safeText(p.inc || 'matches protocol')}`,
    `EXCLUSION CRITERIA: ${safeText(p.exc || 'outside protocol')}`
  ].join('\n');
}
function correctionMemory(data, stage) {
  const rows = (((data || {}).agent || {}).corrections || [])
    .filter(x => !stage || x.stage === stage)
    .slice(-10);
  if (!rows.length) return '';
  return '\nHUMAN CORRECTIONS / ACTIVE-LEARNING LESSONS:\n' +
    'Use these as reviewer feedback. Do not repeat the same mistake pattern; apply a correction only when the current study is substantively similar.\n' +
    rows.map((x, i) => `${i + 1}. ${safeText(x.title || 'Study', 180)}: prior AI said ${x.aiDecision}; human expert changed to ${x.humanDecision}. Prior reason: ${safeText(x.aiReason || 'not recorded', 240)}`).join('\n') +
    '\n';
}
function rubricText(data) {
  const rub = (((data || {}).agent || {}).rubric || []);
  if (!Array.isArray(rub) || !rub.length) return 'Match the configured framework and eligibility criteria. Use MAYBE when the abstract is incomplete but plausibly eligible.';
  return rub.map((r, i) => `${i + 1}. ${safeText(r, 260)}`).join('\n');
}
function buildServerScreenPrompt(data, ref, stage) {
  const p = (data || {}).project || {};
  const agent = (data || {}).agent || {};
  const settings = (data || {}).settings || {};
  const persona = safeText(agent.persona || 'You are a senior systematic reviewer trained in Cochrane/JBI/PRISMA methods.', 1600);
  const strict = settings.strictness || 'balanced';
  const ctx = reviewContext(p);
  if (stage === 'fulltext') {
    const ft = ref.ft || {};
    const text = ft.pdfText
      ? `FULL TEXT EXCERPT:\n${String(ft.pdfText).slice(0, 12000)}`
      : `ABSTRACT ONLY:\n${safeText(ref.abstract || '(no abstract available)', 5000)}`;
    return `${persona}

You are performing full-text eligibility assessment. Use the protocol below, prior human corrections, and the article text.
- If full text is available, exclusion must name the strongest PRISMA reason.
- If only an abstract is available, be cautious and choose maybe unless a clear exclusion is present.
- Do not invent details that are not present.

${ctx}

DECISION RUBRIC:
${rubricText(data)}
${correctionMemory(data, 'ft')}

STUDY
Title: ${safeText(ref.title, 500)}
${text}

Return ONLY JSON:
{"v":"include|exclude|maybe","conf":0-100,"reason":"<specific full-text eligibility rationale>","excl_cat":"<wrong population|wrong intervention|wrong comparator|wrong outcome|wrong design|no usable data|other|>"}`
  }
  return `${persona}

You are screening a title/abstract for this evidence synthesis. Act like a careful dual-reviewer panel:
- First judge population, concept/intervention/exposure, comparator/context, outcome, and study design separately.
- Avoid false exclusions at title/abstract stage. If incomplete but plausibly eligible, choose maybe for human/full-text review.
- Only exclude when a clear exclusion rule is met.
- Strictness: ${strict} (when unsure, ${strict === 'strict' ? 'lean exclude only if a clear exclusion is present' : strict === 'lenient' ? 'lean include/maybe for full-text check' : 'mark maybe'}).

${ctx}

DECISION RUBRIC:
${rubricText(data)}
${correctionMemory(data, 'ta')}

STUDY
Title: ${safeText(ref.title, 500)}
Abstract: ${safeText(ref.abstract || '(no abstract available)', 5000)}

Return ONLY JSON:
{"v":"include|exclude|maybe","conf":0-100,"reason":"<specific one-clause eligibility rationale>","pico":{"p":true/false,"i":true/false,"o":true/false}}`;
}

function extractionFields(data, requested) {
  const defaults = [
    { k: 'design', label: 'Study design' },
    { k: 'country', label: 'Country / setting' },
    { k: 'n', label: 'Sample size (N)' },
    { k: 'population', label: 'Population' },
    { k: 'intervention', label: 'Intervention' },
    { k: 'comparator', label: 'Comparator' },
    { k: 'followup', label: 'Follow-up' },
    { k: 'outcome', label: 'Primary outcome' },
    { k: 'effect', label: 'Effect estimate (with 95% CI)' }
  ];
  const projectFields = ((data || {}).project || {}).extractFields;
  const fields = Array.isArray(requested) && requested.length
    ? requested
    : (Array.isArray(projectFields) && projectFields.length ? projectFields : defaults);
  return fields
    .map(f => ({ k: safeText(f.k || f.key || f.label || '', 60).replace(/[^a-zA-Z0-9_]/g, '_'), label: safeText(f.label || f.k || f.key || '', 140) }))
    .filter(f => f.k && f.label)
    .slice(0, 24);
}

function normalizePaperText(ref) {
  const ft = (ref || {}).ft || {};
  const text = ft.pdfText || ref.fullText || ref.abstract || '';
  return String(text || '').replace(/\r/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n').trim();
}

function sectionWindow(text, pattern, size, label) {
  const m = pattern.exec(text);
  if (!m) return null;
  const start = Math.max(0, m.index - Math.floor(size * 0.18));
  return { label, text: text.slice(start, start + size) };
}

function extractionChunks(text) {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const size = 8500;
  const candidates = [
    { label: 'front_matter', text: clean.slice(0, size) },
    sectionWindow(clean, /\b(methods?|materials and methods|participants|eligibility|interventions?)\b/i, size, 'methods'),
    sectionWindow(clean, /\b(results?|findings|outcomes?|primary outcome|secondary outcome)\b/i, size, 'results'),
    sectionWindow(clean, /\b(table\s*1|baseline|characteristics|sample size|randomi[sz]ed|allocation)\b/i, size, 'tables_baseline'),
    sectionWindow(clean, /\b(table\s*2|effect|mean difference|odds ratio|risk ratio|confidence interval|95%\s*ci|p\s*[<=>])\b/i, size, 'tables_effects')
  ].filter(Boolean);
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = c.text.slice(0, 300).replace(/\s+/g, ' ');
    if (seen.has(key) || c.text.length < 300) continue;
    seen.add(key);
    unique.push(c);
  }
  if (!unique.length) unique.push({ label: 'front_matter', text: clean.slice(0, size) });
  return unique.slice(0, clean.length > size ? 5 : 1);
}

function buildExtractorChunkPrompt(data, ref, fields, chunk, index, total) {
  const fieldList = fields.map(f => `${f.k}: ${f.label}`).join('\n');
  return `You are Viveka Extractor, a strict systematic-review data extraction assistant.
Extract only information explicitly supported by the study text chunk. Do not guess.
For each requested field, return:
- value: concise extracted value, or "NR" if not reported in this chunk
- quote: the shortest exact supporting phrase/sentence from the chunk, or "" if NR
- confidence: 0-100
- status: found|not_reported|unclear

Review protocol:
${reviewContext((data || {}).project || {})}

Study:
Title: ${safeText(ref.title, 500)}
Authors/year/journal: ${safeText(ref.authors || '', 220)} ${safeText(ref.year || '', 40)} ${safeText(ref.journal || '', 220)}

Requested fields:
${fieldList}

Chunk ${index + 1} of ${total}: ${chunk.label}
TEXT:
${chunk.text}

Return ONLY JSON:
{"fields":{"field_key":{"value":"...","quote":"...","confidence":0-100,"status":"found|not_reported|unclear"}},"effect_candidates":[{"outcome":"...","group1":"...","group2":"...","value":"...","quote":"..."}],"warnings":["..."]}`;
}

function buildExtractorMergePrompt(data, ref, fields, chunkResults) {
  const fieldList = fields.map(f => `${f.k}: ${f.label}`).join('\n');
  return `You are Viveka Extractor's senior adjudicator. Merge the chunk-level extraction results into one final extraction table row.
Rules:
- Prefer values with direct quotes and higher confidence.
- If chunks conflict, choose the best supported value and add a warning.
- Keep values short enough for a spreadsheet cell.
- Use "NR" only when not reported after reviewing all chunk results.
- Keep a supporting quote for every non-NR value.
- Flag values needed for meta-analysis if they are missing or ambiguous.

Review protocol:
${reviewContext((data || {}).project || {})}

Study:
Title: ${safeText(ref.title, 500)}

Requested fields:
${fieldList}

Chunk-level JSON results:
${JSON.stringify(chunkResults).slice(0, 26000)}

Return ONLY JSON:
{"fields":{"field_key":{"value":"...","quote":"...","confidence":0-100,"status":"found|not_reported|unclear"}},"effect_candidates":[{"outcome":"...","group1":"...","group2":"...","value":"...","quote":"..."}],"warnings":["..."],"overall_confidence":0-100}`;
}

function flatExtraction(fields, parsed) {
  const out = {};
  const evidence = {};
  const src = parsed && parsed.fields && typeof parsed.fields === 'object' ? parsed.fields : {};
  for (const f of fields) {
    const cell = src[f.k] || {};
    const value = typeof cell === 'string' ? cell : (cell.value || 'NR');
    out[f.k] = safeText(value || 'NR', 900);
    evidence[f.k] = {
      quote: safeText(cell.quote || '', 1200),
      confidence: Number(cell.confidence || 0),
      status: safeText(cell.status || (value && value !== 'NR' ? 'found' : 'not_reported'), 40)
    };
  }
  return {
    values: out,
    evidence,
    effectCandidates: Array.isArray(parsed.effect_candidates) ? parsed.effect_candidates.slice(0, 10) : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings.map(w => safeText(w, 260)).slice(0, 12) : [],
    overallConfidence: Number(parsed.overall_confidence || 0)
  };
}
async function runServerExtraction({ projectId, userId, data, ref, fields, model }) {
  const extractFields = extractionFields(data, fields);
  if (!extractFields.length) {
    const err = new Error('At least one extraction field is required');
    err.status = 400;
    throw err;
  }
  const paperText = normalizePaperText(ref);
  if (!paperText) {
    const err = new Error('No full text or abstract available for extraction');
    err.status = 400;
    throw err;
  }

  const configured = configuredAIModels();
  const agent = data.agent || {};
  let selectedModel = model || agent.advModel || agent.model || configured[0] || 'gemini-flash';
  if (!hasRealValue((aiModelMeta(selectedModel) || {}).key) && configured.length) selectedModel = configured[0];
  const chunks = extractionChunks(paperText);
  const creditCost = paperText.length > 12000 ? 12 : (paperText.length > 4000 ? 8 : 5);
  const balance = await aiBalance(userId);
  if (balance < creditCost) {
    const err = new Error(`Not enough Viveka AI credits. You have ${balance}, need ${creditCost}. Manual extraction is still free.`);
    err.status = 402;
    err.balance = balance;
    throw err;
  }

  const chunkResults = [];
  for (let i = 0; i < chunks.length; i++) {
    const prompt = buildExtractorChunkPrompt(data, ref, extractFields, chunks[i], i, chunks.length);
    const raw = await serverLLM(prompt, 1400, selectedModel);
    chunkResults.push(Object.assign({ _chunk: chunks[i].label }, parseAIJSON(raw)));
  }
  let finalParsed;
  if (chunkResults.length > 1) {
    const mergePrompt = buildExtractorMergePrompt(data, ref, extractFields, chunkResults);
    finalParsed = parseAIJSON(await serverLLM(mergePrompt, 1800, selectedModel));
  } else {
    finalParsed = chunkResults[0] || { fields: {} };
    if (finalParsed.overall_confidence == null) {
      const vals = Object.values(finalParsed.fields || {}).map(x => Number((x || {}).confidence || 0)).filter(Boolean);
      finalParsed.overall_confidence = vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
    }
  }
  const result = flatExtraction(extractFields, finalParsed);
  const aiCredits = await chargeAICredits(userId, creditCost, 'extract:fulltext', selectedModel, projectId);
  return {
    ok: true,
    server: true,
    model: selectedModel,
    aiCredits,
    creditsUsed: creditCost,
    chunksUsed: chunks.map(c => c.label),
    extraction: result.values,
    evidence: result.evidence,
    effectCandidates: result.effectCandidates,
    warnings: result.warnings,
    overallConfidence: result.overallConfidence
  };
}
async function projectDataForMember(projectId, userId) {
  const role = await memberRole(projectId, userId);
  if (!role) return null;
  const rows = await db.q('SELECT data,version FROM projects WHERE id=$1', [projectId]);
  if (!rows[0]) return null;
  let data = rows[0].data || {};
  if (typeof data === 'string') data = JSON.parse(data || '{}');
  return { data, role, version: rows[0].version };
}
async function saveProjectDataDirect(projectId, data, userId) {
  const cur = await db.q('SELECT version FROM projects WHERE id=$1', [projectId]);
  if (!cur[0]) {
    const err = new Error('Project not found');
    err.status = 404;
    throw err;
  }
  const newV = Number(cur[0].version) + 1;
  await db.q('UPDATE projects SET data=$1, version=$2, updated_at=now(), updated_by=$3, title=$4 WHERE id=$5',
    [JSON.stringify(data || {}), newV, userId, (data && data.project && data.project.title) || 'Untitled review', projectId]);
  return newV;
}

function getMailer() {
  if (mailer) return mailer;
  if (!smtpEmailConfigured()) return null;
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
function parseFromHeader(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(.*)<([^>]+)>$/);
  if (m) return { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() };
  return { name: 'Pramana', email: s };
}
function escapeHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function transactionalFrom() {
  return process.env.SMTP_FROM || 'Pramana AI <pramana.ai.srma@gmail.com>';
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
async function sendViaBrevoApi({ to, subject, html }) {
  const sender = parseFromHeader(transactionalFrom());
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'api-key': process.env.BREVO_API_KEY
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html
    })
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok) {
    throw new Error((data && (data.message || data.code)) || ('Brevo API HTTP ' + res.status));
  }
  return data;
}
async function sendTransactionalEmail({ to, subject, html }) {
  if (apiEmailConfigured()) await sendViaBrevoApi({ to, subject, html });
  else {
    const m = getMailer();
    if (!m) return { sent: false, reason: 'email-not-configured' };
    await m.sendMail({ from: transactionalFrom(), to, subject, html });
  }
  return { sent: true };
}
function emailFrame({ pretitle, title, body, ctaLabel, ctaLink, note }) {
  return `<!doctype html>
  <html><body style="margin:0;padding:0;background:#f4f7fb;font-family:Segoe UI,Arial,sans-serif;color:#10213a">
    <div style="display:none;max-height:0;overflow:hidden;color:#f4f7fb">${escapeHtml(title)} - Pramana Evidence Synthesis</div>
    <div style="max-width:640px;margin:0 auto;padding:28px 16px">
      <div style="background:#ffffff;border:1px solid #d9e3f1;border-radius:18px;overflow:hidden;box-shadow:0 14px 40px rgba(16,33,58,.08)">
        <div style="padding:22px 24px;background:linear-gradient(135deg,#0f8b8d,#3657d6);color:#fff">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:48px;height:48px;border-radius:14px;background:#ffffff;color:#3657d6;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:900;line-height:48px;text-align:center;box-shadow:0 8px 20px rgba(16,33,58,.16)">P</div>
            <div>
              <div style="font-size:11px;letter-spacing:.12em;text-transform:uppercase;opacity:.88">${escapeHtml(pretitle || 'Pramana Evidence Synthesis')}</div>
              <div style="font-size:24px;font-weight:800;line-height:1.15;margin-top:2px">${escapeHtml(title)}</div>
            </div>
          </div>
        </div>
        <div style="padding:24px">
          <div style="font-size:15px;line-height:1.65;color:#24384f">${body}</div>
          ${ctaLink ? `<div style="margin:22px 0 10px"><a href="${escapeHtml(ctaLink)}" style="display:inline-block;background:#3657d6;color:#fff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">${escapeHtml(ctaLabel || 'Open Pramana')}</a></div>
          <div style="font-size:12px;line-height:1.5;color:#60748a;word-break:break-all">${escapeHtml(ctaLink)}</div>` : ''}
          ${note ? `<div style="margin-top:18px;font-size:12px;line-height:1.6;color:#60748a">${note}</div>` : ''}
          <div style="border-top:1px solid #e2eaf5;margin-top:22px;padding-top:14px;font-size:12px;line-height:1.6;color:#60748a">
            <b style="color:#10213a">Pramāṇa - Evidence Synthesis</b><br>
            Contact: <a href="mailto:pramana.ai.srma@gmail.com" style="color:#3657d6;text-decoration:none">pramana.ai.srma@gmail.com</a><br>
            Proudly Made in India
          </div>
        </div>
      </div>
    </div>
  </body></html>`;
}
async function sendInviteEmail(to, project, link, inviter) {
  const subject = `${inviter} invited you to a Pramana review: ${project}`;
  const html = emailFrame({
    pretitle: 'Pramana Evidence Synthesis',
    title: 'Review invitation',
    body: `<p>Hello,</p>
           <p><b>${escapeHtml(inviter)}</b> has invited you to collaborate on the review <b>${escapeHtml(project)}</b>.</p>
           <p>Open the shared workspace below to join the review, screen studies, and work with the same live data.</p>`,
    ctaLabel: 'Open the review',
    ctaLink: link,
    note: 'This is a transactional invitation email from Pramana. If the button does not open, paste the link above into your browser.'
  });
  return sendTransactionalEmail({ to, subject, html });
}
async function sendReminderEmail(to, project, inviter) {
  const subject = `Reminder: Screening pending for ${project}`;
  const html = emailFrame({
    pretitle: 'Pramana Evidence Synthesis',
    title: 'Screening reminder',
    body: `<p>Hello,</p>
           <p><b>${escapeHtml(inviter)}</b> has sent a gentle reminder to complete your assigned screening queue for the review <b>${escapeHtml(project)}</b>.</p>
           <p>Open the workspace below to jump into your assigned queue and continue screening.</p>`,
    ctaLabel: 'Continue screening',
    ctaLink: APP_URL,
    note: 'This is a transactional reminder email from Pramana.'
  });
  return sendTransactionalEmail({ to, subject, html });
}
async function sendResetEmail(to, link) {
  const subject = 'Reset your Pramana password';
  const html = emailFrame({
    pretitle: 'Pramana Evidence Synthesis',
    title: 'Reset your password',
    body: `<p>Hello,</p>
           <p>You asked to reset your Pramana password.</p>
           <p>This link will let you choose a new password and expires in 1 hour.</p>`,
    ctaLabel: 'Choose a new password',
    ctaLink: link,
    note: 'If you did not request this, you can ignore this email. Your current password will remain unchanged unless this link is used.'
  });
  return sendTransactionalEmail({ to, subject, html });
}
async function sendWelcomeEmail(to, name) {
  const subject = 'Welcome to Pramana';
  const html = emailFrame({
    pretitle: 'Pramana Evidence Synthesis',
    title: 'Your account is ready',
    body: `<p>Hello ${escapeHtml(name || 'there')},</p>
           <p>Your Pramana account has been created successfully.</p>
           <p>You can now create reviews, invite collaborators, screen studies, extract data, and run meta-analysis from the same workspace.</p>`,
    ctaLabel: 'Open Pramana',
    ctaLink: APP_URL,
    note: 'This email confirms that account creation was successful.'
  });
  return sendTransactionalEmail({ to, subject, html });
}
async function sendPasswordChangedEmail(to, name) {
  const subject = 'Your Pramana password was changed';
  const html = emailFrame({
    pretitle: 'Pramana Account Security',
    title: 'Password changed',
    body: `<p>Hello ${escapeHtml(name || 'there')},</p>
           <p>Your Pramana password was changed successfully.</p>
           <p>If this was you, no action is needed. If you did not make this change, reset your password immediately and contact support.</p>`,
    ctaLabel: 'Open Pramana',
    ctaLink: APP_URL,
    note: 'This is a security notification for your Pramana account.'
  });
  return sendTransactionalEmail({ to, subject, html });
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
  const user = { id, email: email.toLowerCase(), name: name || email.split('@')[0], ai_credits: 200 };
  await autoAcceptInvites(user);
  setAuthCookie(res, user);
  let welcomeEmailQueued = false, emailError;
  if (emailConfigured()) {
    queueEmail('Welcome email', user.email, () => sendWelcomeEmail(user.email, user.name));
    welcomeEmailQueued = true;
  }
  res.json({ user: publicUser(user), welcomeEmailQueued, emailError });
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  // brute-force protection: max 8 attempts per email+IP per 15 min
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('login:' + (email||'').toLowerCase() + ':' + ip, 8, 15 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: `Too many login attempts. Try again in ${Math.ceil(rl.retryAfter/60)} minute(s).` });
  const rows = await db.q('SELECT id,email,name,password_hash,ai_credits FROM users WHERE email=$1', [(email||'').toLowerCase()]);
  const u = rows[0];
  if (!u || !u.password_hash || !(await bcrypt.compare(password || '', u.password_hash)))
    return res.status(401).json({ error: 'Wrong email or password' });
  const user = { id: u.id, email: u.email, name: u.name, ai_credits: u.ai_credits };
  setAuthCookie(res, user);
  res.json({ user: publicUser(user) });
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
    let rows = await db.q('SELECT id,email,name,ai_credits FROM users WHERE email=$1', [email]);
    let user = rows[0];
    if (!user) {
      const id = uid('u_');
      await db.q('INSERT INTO users (id,email,name,google_id) VALUES ($1,$2,$3,$4)', [id, email, p.name || email.split('@')[0], p.sub]);
      user = { id, email, name: p.name || email.split('@')[0], ai_credits: 200 };
    }
    await autoAcceptInvites(user);
    setAuthCookie(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) { res.status(401).json({ error: 'Google verification failed' }); }
});

app.post('/api/auth/logout', (req, res) => { res.clearCookie('pramana_token'); res.json({ ok: true }); });
app.get('/api/me', requireAuth(async (req, res) => res.json({ user: publicUser(req.user) })));

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
  const urows = await db.q('SELECT id,email,name,ai_credits FROM users WHERE id=$1', [r.user_id]);
  setAuthCookie(res, urows[0]);
  if (urows[0] && emailConfigured()) {
    queueEmail('Password changed email', urows[0].email, () => sendPasswordChangedEmail(urows[0].email, urows[0].name));
  }
  res.json({ ok: true, user: publicUser(urows[0]) });
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
            COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(p.data->'refs')='array' THEN p.data->'refs' ELSE '[]'::jsonb END),0) AS total_count,
            (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'refs')='array' THEN p.data->'refs' ELSE '[]'::jsonb END) AS r(ref)
              WHERE NOT COALESCE((r.ref->>'dup')::boolean,false) AND ( (r.ref->'ta'->>'final') IS NOT NULL OR (jsonb_typeof(r.ref->'reviews'->'ta') = 'object' AND r.ref->'reviews'->'ta' != '{}'::jsonb) )) AS screened_count,
            (SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(p.data->'refs')='array' THEN p.data->'refs' ELSE '[]'::jsonb END) AS r(ref)
              WHERE NOT COALESCE((r.ref->>'dup')::boolean,false) AND (r.ref->'ft'->>'decision')='include') AS included_count,
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

app.post('/api/projects/:id/remind', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (role !== 'owner' && role !== 'editor') return res.status(403).json({ error: 'Only owner/editor can send reminders' });
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'Email required' });
  const normalizedEmail = email.toLowerCase();
  const proj = await db.q('SELECT title FROM projects WHERE id=$1', [req.params.id]);
  
  if (emailConfigured()) {
    queueEmail('Reminder email', normalizedEmail, () => sendReminderEmail(normalizedEmail, (proj[0]||{}).title || 'review', req.user.name || req.user.email));
    return res.json({ ok: true, sent: true });
  } else {
    return res.json({ ok: false, error: 'Email server is not configured on this instance' });
  }
}));

app.delete('/api/projects/:id/members/:userId', requireAuth(async (req, res) => {
  if ((await memberRole(req.params.id, req.user.id)) !== 'owner') return res.status(403).json({ error: 'Only owner' });
  await db.q('DELETE FROM members WHERE project_id=$1 AND user_id=$2', [req.params.id, req.params.userId]);
  res.json({ ok: true });
}));

/* ---------------- AI ---------------- */
app.post('/api/ai/generate', requireAuth(async (req, res) => {
  const { prompt, maxTok, model } = req.body || {};
  const selectedModel = model || 'gemini-flash';
  const creditCost = Number(req.body.creditCost) || 1;
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'Prompt required' });
  if (prompt.length > 30000) return res.status(413).json({ error: 'Prompt is too large for this Phase 1 server endpoint' });
  const balance = await aiBalance(req.user.id);
  if (balance < creditCost) return res.status(402).json({ error: `Not enough Viveka AI credits. You have ${balance}, need ${creditCost}. Manual work is still free.`, aiCredits: balance });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('ai:' + req.user.id + ':' + ip, 120, 60 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: `AI limit reached. Try again in ${Math.ceil(rl.retryAfter/60)} minute(s).` });
  try {
    const text = await serverLLM(prompt, maxTok, selectedModel);
    const aiCredits = await chargeAICredits(req.user.id, creditCost, 'generate', selectedModel, null);
    res.json({ text, model: selectedModel, server: true, aiCredits, creditsUsed: creditCost });
  } catch (e) {
    const msg = e && e.message ? e.message : 'AI server failed';
    const status = e.status || (/not configured/i.test(msg) ? 503 : 502);
    res.status(status).json({ error: msg, aiCredits: e.balance });
  }
}));

app.post('/api/projects/:id/ai/screen', requireAuth(async (req, res) => {
  const { refId, stage } = req.body || {};
  const normalizedStage = stage === 'fulltext' ? 'fulltext' : 'ta';
  if (!refId) return res.status(400).json({ error: 'refId required' });
  const project = await projectDataForMember(req.params.id, req.user.id);
  if (!project) return res.status(403).json({ error: 'Not a member' });
  const data = project.data || {};
  const refs = Array.isArray(data.refs) ? data.refs : [];
  const ref = refs.find(r => r && r.id === refId);
  if (!ref) return res.status(404).json({ error: 'Study not found in project' });
  const agent = data.agent || {};
  const selectedModel = normalizedStage === 'fulltext'
    ? (agent.advModel || agent.model || 'gemini-flash')
    : (agent.model || 'gemini-flash');
  const creditCost = normalizedStage === 'fulltext' ? 5 : 1;
  const balance = await aiBalance(req.user.id);
  if (balance < creditCost) return res.status(402).json({ error: `Not enough Viveka AI credits. You have ${balance}, need ${creditCost}. Manual screening is still free.`, aiCredits: balance });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('ai-screen:' + req.user.id + ':' + ip, 180, 60 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: `AI screening limit reached. Try again in ${Math.ceil(rl.retryAfter/60)} minute(s).` });
  try {
    const prompt = buildServerScreenPrompt(data, ref, normalizedStage);
    if (prompt.length > 32000) return res.status(413).json({ error: 'Study text is too large for server screening' });
    const raw = await serverLLM(prompt, normalizedStage === 'fulltext' ? 520 : 380, selectedModel);
    const parsed = parseAIJSON(raw);
    const decision = normDecision(parsed.v);
    const aiCredits = await chargeAICredits(req.user.id, creditCost, 'screen:' + normalizedStage, selectedModel, req.params.id);
    res.json({
      ok: true,
      stage: normalizedStage,
      server: true,
      model: selectedModel,
      aiCredits,
      creditsUsed: creditCost,
      decision,
      conf: Number(parsed.conf || 50),
      reason: safeText(parsed.reason || '', 1000),
      pico: parsed.pico || {},
      exclCat: safeText(parsed.excl_cat || parsed.exclCat || '', 120)
    });
  } catch (e) {
    const msg = e && e.message ? e.message : 'AI screening failed';
    const status = e.status || (/not configured/i.test(msg) ? 503 : 502);
    res.status(status).json({ error: msg, aiCredits: e.balance });
  }
}));

app.post('/api/projects/:id/ai/extract', requireAuth(async (req, res) => {
  const { refId, fields, model } = req.body || {};
  if (!refId) return res.status(400).json({ error: 'refId required' });
  const project = await projectDataForMember(req.params.id, req.user.id);
  if (!project) return res.status(403).json({ error: 'Not a member' });
  const data = project.data || {};
  const refs = Array.isArray(data.refs) ? data.refs : [];
  const ref = refs.find(r => r && r.id === refId);
  if (!ref) return res.status(404).json({ error: 'Study not found in project' });
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0];
  const rl = rateLimit('ai-extract:' + req.user.id + ':' + ip, 60, 60 * 60 * 1000);
  if (!rl.ok) return res.status(429).json({ error: `AI extraction limit reached. Try again in ${Math.ceil(rl.retryAfter/60)} minute(s).` });

  try {
    res.json(await runServerExtraction({ projectId: req.params.id, userId: req.user.id, data, ref, fields, model }));
  } catch (e) {
    const msg = e && e.message ? e.message : 'AI extraction failed';
    const status = e.status || (/not configured/i.test(msg) ? 503 : 502);
    res.status(status).json({ error: msg, aiCredits: e.balance });
  }
}));

async function ocrImageBuffer(buffer) {
  const worker = await createWorker('eng');
  try {
    const result = await worker.recognize(buffer);
    return (result && result.data && result.data.text) ? result.data.text : '';
  } finally {
    await worker.terminate();
  }
}
async function extractUploadedText(file) {
  if (!file || !file.buffer) {
    const err = new Error('File is required');
    err.status = 400;
    throw err;
  }
  const name = file.originalname || 'uploaded file';
  const mime = String(file.mimetype || '').toLowerCase();
  const lower = name.toLowerCase();
  if (mime.includes('text') || /\.(txt|text|md)$/i.test(lower)) {
    return { text: file.buffer.toString('utf8'), method: 'server-text', pages: null };
  }
  if (mime.includes('pdf') || /\.pdf$/i.test(lower)) {
    const parser = new PDFParse({ data: file.buffer });
    try {
      const parsed = await parser.getText({ first: 80 });
      const text = String(parsed.text || '').trim();
      if (text.length < 80) {
        const err = new Error('This PDF appears scanned or image-only. Upload a text PDF, paste text, or upload page images for OCR.');
        err.status = 422;
        err.needsOcr = true;
        throw err;
      }
      return { text, method: 'server-pdf-text', pages: parsed.total || null };
    } finally {
      await parser.destroy();
    }
  }
  if (mime.startsWith('image/') || /\.(png|jpe?g|webp|tiff?)$/i.test(lower)) {
    const text = (await ocrImageBuffer(file.buffer)).trim();
    if (text.length < 20) {
      const err = new Error('OCR could not extract usable text from this image.');
      err.status = 422;
      throw err;
    }
    return { text, method: 'server-ocr-image', pages: 1 };
  }
  const err = new Error('Unsupported file type. Upload PDF, TXT, PNG, JPG, WEBP, or TIFF.');
  err.status = 415;
  throw err;
}
function isPDFUpload(file) {
  const name = String((file && file.originalname) || '').toLowerCase();
  const mime = String((file && file.mimetype) || '').toLowerCase();
  return mime.includes('pdf') || /\.pdf$/i.test(name);
}
async function storeProjectFile({ projectId, refId, userId, file }) {
  const id = uid('file_');
  await db.q(
    'INSERT INTO files (id,project_id,ref_id,user_id,filename,mimetype,size,data) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, projectId, refId, userId, file.originalname || 'uploaded file', file.mimetype || 'application/octet-stream', file.size || file.buffer.length, file.buffer]
  );
  return id;
}
app.post('/api/projects/:id/refs/:refId/fulltext/upload',
  requireAuthMiddleware,
  upload.single('file'),
  async (req, res) => {
    try {
      const role = await memberRole(req.params.id, req.user.id);
      if (!role) return res.status(403).json({ error: 'Not a member' });
      const project = await projectDataForMember(req.params.id, req.user.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const data = project.data || {};
      const refs = Array.isArray(data.refs) ? data.refs : [];
      const ref = refs.find(r => r && r.id === req.params.refId);
      if (!ref) return res.status(404).json({ error: 'Study not found in project' });
      const extracted = await extractUploadedText(req.file);
      const fileId = isPDFUpload(req.file) ? await storeProjectFile({ projectId: req.params.id, refId: req.params.refId, userId: req.user.id, file: req.file }) : null;
      ref.ft = Object.assign({}, ref.ft || {}, {
        pdfText: extracted.text.slice(0, 350000),
        pdfName: req.file.originalname || 'uploaded file',
        fileId: fileId || (ref.ft && ref.ft.fileId) || null,
        fileMime: req.file.mimetype || '',
        fileSize: req.file.size || req.file.buffer.length,
        retrieved: true,
        source: extracted.method,
        serverExtractedAt: new Date().toISOString(),
        serverExtractedBy: req.user.id,
        pages: extracted.pages
      });
      const version = await saveProjectDataDirect(req.params.id, data, req.user.id);
      res.json({ ok: true, version, ft: ref.ft, chars: ref.ft.pdfText.length, method: extracted.method, pages: extracted.pages });
    } catch (e) {
      res.status(e.status || 500).json({ error: e.message || 'Full-text upload failed', needsOcr: !!e.needsOcr });
    }
  }
);
app.get('/api/projects/:id/files/:fileId', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (!role) return res.status(403).send('Not a member');
  const rows = await db.q('SELECT filename,mimetype,size,data FROM files WHERE id=$1 AND project_id=$2', [req.params.fileId, req.params.id]);
  const file = rows[0];
  if (!file) return res.status(404).send('File not found');
  const name = String(file.filename || 'paper.pdf').replace(/[\r\n"]/g, '');
  const mime = file.mimetype || 'application/pdf';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', file.size || (file.data ? file.data.length : 0));
  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.end(file.data);
}));

/* ---------------- SERVER JOBS ---------------- */
const activeJobs = new Set();
async function jobRow(jobId) {
  const rows = await db.q('SELECT id,project_id,user_id,type,status,payload,progress,result,error,cancel_requested FROM jobs WHERE id=$1', [jobId]);
  return rows[0] || null;
}
function publicJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    type: row.type,
    status: row.status,
    progress: typeof row.progress === 'string' ? JSON.parse(row.progress || '{}') : (row.progress || {}),
    result: typeof row.result === 'string' ? JSON.parse(row.result || '{}') : (row.result || {}),
    error: row.error || null,
    cancelRequested: !!row.cancel_requested
  };
}
async function updateJob(jobId, fields) {
  const row = await jobRow(jobId);
  if (!row) return null;
  const next = Object.assign({}, row, fields);
  await db.q(
    'UPDATE jobs SET status=$1, progress=$2, result=$3, error=$4, cancel_requested=$5, updated_at=now(), started_at=COALESCE(started_at,$6), finished_at=$7 WHERE id=$8',
    [
      next.status,
      JSON.stringify(next.progress || {}),
      JSON.stringify(next.result || {}),
      next.error || null,
      !!next.cancel_requested,
      next.status === 'running' ? new Date().toISOString() : null,
      ['succeeded', 'failed', 'cancelled'].includes(next.status) ? new Date().toISOString() : null,
      jobId
    ]
  );
  return jobRow(jobId);
}
async function runExtractAllJob(job) {
  let payload = typeof job.payload === 'string' ? JSON.parse(job.payload || '{}') : (job.payload || {});
  const project = await projectDataForMember(job.project_id, job.user_id);
  if (!project) throw Object.assign(new Error('Job user is no longer a project member'), { status: 403 });
  const data = project.data || {};
  const refs = Array.isArray(data.refs) ? data.refs : [];
  const wanted = Array.isArray(payload.refIds) && payload.refIds.length ? new Set(payload.refIds) : null;
  const list = refs.filter(r => r && !r.dup && (!wanted || wanted.has(r.id)) && r.ta && (r.ta.final === 'include' || r.ta.final === 'maybe') && r.ft && r.ft.decision === 'include' && (r.ft.pdfText || r.fullText || r.abstract));
  const fields = payload.fields || extractionFields(data);
  const model = payload.model;
  let ok = 0, failed = 0;
  await updateJob(job.id, { progress: { total: list.length, done: 0, ok, failed, current: '' } });
  for (let i = 0; i < list.length; i++) {
    const latest = await jobRow(job.id);
    if (latest && latest.cancel_requested) {
      await updateJob(job.id, { status: 'cancelled', result: { ok, failed, cancelledAt: i } });
      return;
    }
    const ref = list[i];
    await updateJob(job.id, { progress: { total: list.length, done: i, ok, failed, current: ref.title || ref.id } });
    try {
      const result = await runServerExtraction({ projectId: job.project_id, userId: job.user_id, data, ref, fields, model });
      ref.extract = result.extraction || {};
      ref.extractEvidence = result.evidence || {};
      ref.extractWarnings = result.warnings || [];
      ref.extractEffectCandidates = result.effectCandidates || [];
      ref.extractMeta = {
        server: true,
        jobId: job.id,
        model: result.model,
        creditsUsed: result.creditsUsed || 0,
        chunksUsed: result.chunksUsed || [],
        overallConfidence: result.overallConfidence || 0,
        reviewedAt: new Date().toISOString()
      };
      ok++;
    } catch (e) {
      ref.extractWarnings = (ref.extractWarnings || []).concat('Extraction job failed: ' + (e.message || 'unknown error')).slice(-12);
      failed++;
      if (e.status === 402 || /credits|configured|provider/i.test(e.message || '')) {
        await saveProjectDataDirect(job.project_id, data, job.user_id);
        throw e;
      }
    }
    await saveProjectDataDirect(job.project_id, data, job.user_id);
    await updateJob(job.id, { progress: { total: list.length, done: i + 1, ok, failed, current: ref.title || ref.id } });
  }
  await updateJob(job.id, { status: 'succeeded', result: { ok, failed, total: list.length } });
}
async function runJob(jobId) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  try {
    let job = await updateJob(jobId, { status: 'running', error: null });
    if (!job) return;
    if (job.type === 'extract-all') await runExtractAllJob(job);
    else throw new Error('Unknown job type: ' + job.type);
  } catch (e) {
    await updateJob(jobId, { status: 'failed', error: e.message || 'Job failed' });
  } finally {
    activeJobs.delete(jobId);
  }
}
app.post('/api/projects/:id/jobs', requireAuth(async (req, res) => {
  const { type, refIds, fields, model } = req.body || {};
  if (type !== 'extract-all') return res.status(400).json({ error: 'Unsupported job type' });
  const role = await memberRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Not a member' });
  const id = uid('job_');
  const payload = { refIds: Array.isArray(refIds) ? refIds.slice(0, 10000) : null, fields, model };
  await db.q('INSERT INTO jobs (id,project_id,user_id,type,status,payload,progress,result) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
    [id, req.params.id, req.user.id, type, 'queued', JSON.stringify(payload), JSON.stringify({ total: 0, done: 0 }), JSON.stringify({})]);
  setTimeout(() => runJob(id), 0);
  res.json({ ok: true, job: publicJob(await jobRow(id)) });
}));
app.get('/api/jobs/:id', requireAuth(async (req, res) => {
  const row = await jobRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (row.user_id !== req.user.id && !(await memberRole(row.project_id, req.user.id))) return res.status(403).json({ error: 'Not allowed' });
  res.json({ job: publicJob(row) });
}));
app.post('/api/jobs/:id/cancel', requireAuth(async (req, res) => {
  const row = await jobRow(req.params.id);
  if (!row) return res.status(404).json({ error: 'Job not found' });
  if (row.user_id !== req.user.id && !(await memberRole(row.project_id, req.user.id))) return res.status(403).json({ error: 'Not allowed' });
  const updated = await updateJob(req.params.id, { cancel_requested: true, status: row.status === 'queued' ? 'cancelled' : row.status });
  res.json({ ok: true, job: publicJob(updated) });
}));

/* --- Reset extraction data --- */
app.post('/api/projects/:id/reset-extraction', requireAuth(async (req, res) => {
  const role = await memberRole(req.params.id, req.user.id);
  if (!role) return res.status(403).json({ error: 'Not a member' });
  const project = await projectDataForMember(req.params.id, req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const data = project.data || {};
  const refs = Array.isArray(data.refs) ? data.refs : [];
  let count = 0;
  refs.forEach(r => {
    if (r && !r.dup && r.ft && r.ft.decision === 'include' && r.extract) {
      delete r.extract;
      delete r.extractEvidence;
      delete r.extractWarnings;
      delete r.extractEffectCandidates;
      delete r.extractMeta;
      count++;
    }
  });
  if (count > 0) {
    const version = await saveProjectDataDirect(req.params.id, data, req.user.id);
    res.json({ ok: true, reset: count, version });
  } else {
    res.json({ ok: true, reset: 0 });
  }
}));

/* ---------------- ADMIN: credits and usage ---------------- */
app.get('/api/admin/usage', requireAdmin(async (req, res) => {
  const users = await db.q(
    `SELECT u.id,u.email,u.name,u.ai_credits,u.created_at,
            COALESCE(SUM(CASE WHEN a.credits > 0 THEN a.credits ELSE 0 END),0) AS credits_used,
            COUNT(a.id) AS ai_calls
     FROM users u
     LEFT JOIN ai_usage a ON a.user_id=u.id
     GROUP BY u.id,u.email,u.name,u.ai_credits,u.created_at
     ORDER BY u.created_at DESC
     LIMIT 500`, []);
  const recent = await db.q(
    `SELECT a.id,a.user_id,u.email,u.name,a.project_id,a.feature,a.model,a.credits,a.created_at
     FROM ai_usage a
     JOIN users u ON u.id=a.user_id
     ORDER BY a.created_at DESC
     LIMIT 200`, []);
  res.json({ users, recent });
}));

app.post('/api/admin/users/:id/credits', requireAdmin(async (req, res) => {
  const delta = Math.trunc(Number((req.body || {}).delta || 0));
  const reason = safeText((req.body || {}).reason || 'manual-admin-adjustment', 120);
  if (!delta) return res.status(400).json({ error: 'delta required' });
  const rows = await db.q('UPDATE users SET ai_credits=GREATEST(0,ai_credits+$1) WHERE id=$2 RETURNING id,email,name,ai_credits', [delta, req.params.id]);
  if (!rows[0]) return res.status(404).json({ error: 'User not found' });
  if (delta > 0) {
    await db.q('INSERT INTO ai_usage (id,user_id,project_id,feature,model,credits) VALUES ($1,$2,$3,$4,$5,$6)',
      [uid('au_'), req.params.id, null, 'admin-credit:' + reason, 'manual', -delta]);
  }
  res.json({ user: publicUser(rows[0]) });
}));

/* ---------------- config + static ---------------- */
app.get('/api/config', (req, res) => res.json({
  googleClientId: GOOGLE_CLIENT_ID,
  emailEnabled: emailConfigured(),
  aiServerEnabled: aiServerEnabled(),
  aiModels: configuredAIModels()
}));
app.get('/api/email/status', (req, res) => res.json({
  configured: emailConfigured(),
  transport: emailState.transport,
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
