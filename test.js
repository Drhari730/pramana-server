/* Integration test: runs the real Express app against an in-memory store that
   emulates just enough Postgres for our queries. No external DB needed. */
const http = require('http');
const db = require('./db');
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_AI_API_KEY = '';
process.env.OPENAI_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.DEEPSEEK_API_KEY = '';
process.env.ZAI_API_KEY = '';

/* ---- tiny in-memory tables ---- */
const T = { users: [], projects: [], members: [], invites: [], resets: [], usage: [] };
function clone(o){ return JSON.parse(JSON.stringify(o)); }

/* A hand-written matcher for the exact queries server.js issues.
   Returns rows (array). Keeps the test honest: if a query isn't handled it throws. */
async function mockQuery(text, params=[]) {
  const s = text.replace(/\s+/g,' ').trim();

  if (s.startsWith('CREATE TABLE') || s.startsWith('CREATE INDEX')) return [];

  // users
  if (s==='SELECT id,email,name FROM users WHERE id=$1')
    return T.users.filter(u=>u.id===params[0]).map(u=>({id:u.id,email:u.email,name:u.name}));
  if (s==='SELECT id,email,name,ai_credits FROM users WHERE id=$1')
    return T.users.filter(u=>u.id===params[0]).map(u=>({id:u.id,email:u.email,name:u.name,ai_credits:u.ai_credits||0}));
  if (s==='SELECT id FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>({id:u.id}));
  if (s==='SELECT id,email,name FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>({id:u.id,email:u.email,name:u.name}));
  if (s==='SELECT id,email,name,ai_credits FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>({id:u.id,email:u.email,name:u.name,ai_credits:u.ai_credits||0}));
  if (s==='SELECT id,email,name,password_hash FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>clone(u));
  if (s==='SELECT id,email,name,password_hash,ai_credits FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>clone(u));
  if (s.startsWith('INSERT INTO users')) {
    const cols = s.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c=>c.trim());
    const row={ai_credits:50}; cols.forEach((c,i)=>row[c==='password_hash'?'password_hash':c]=params[i]); T.users.push(row); return [];
  }
  if (s==='SELECT ai_credits FROM users WHERE id=$1')
    return T.users.filter(u=>u.id===params[0]).map(u=>({ai_credits:u.ai_credits||0}));
  if (s==='UPDATE users SET ai_credits=ai_credits-$1 WHERE id=$2 AND ai_credits >= $1 RETURNING ai_credits'){
    const u=T.users.find(u=>u.id===params[1]);
    if(!u || (u.ai_credits||0)<params[0]) return [];
    u.ai_credits=(u.ai_credits||0)-params[0];
    return [{ai_credits:u.ai_credits}];
  }
  if (s.startsWith('UPDATE users SET ai_credits=GREATEST')) {
    const u=T.users.find(u=>u.id===params[1]);
    if(!u)return [];
    u.ai_credits=Math.max(0,(u.ai_credits||0)+params[0]);
    return [{id:u.id,email:u.email,name:u.name,ai_credits:u.ai_credits}];
  }
  if (s==='SELECT id,password_hash FROM users WHERE email=$1')
    return T.users.filter(u=>u.email===params[0]).map(u=>({id:u.id,password_hash:u.password_hash}));
  if (s==='UPDATE users SET password_hash=$1 WHERE id=$2'){ const u=T.users.find(u=>u.id===params[1]); if(u)u.password_hash=params[0]; return []; }

  // ai_usage
  if (s.startsWith('INSERT INTO ai_usage')){ T.usage.push({id:params[0],user_id:params[1],project_id:params[2],feature:params[3],model:params[4],credits:params[5]}); return []; }

  // password_resets
  if (s.startsWith('INSERT INTO password_resets')){ T.resets.push({token:params[0],user_id:params[1],expires_at:params[2],used:false}); return []; }
  if (s==='SELECT user_id,expires_at,used FROM password_resets WHERE token=$1')
    return T.resets.filter(r=>r.token===params[0]).map(r=>clone(r));
  if (s==='UPDATE password_resets SET used=true WHERE token=$1'){ const r=T.resets.find(r=>r.token===params[0]); if(r)r.used=true; return []; }

  // projects
  if (s.startsWith('INSERT INTO projects')) {
    const cols=s.match(/\(([^)]+)\) VALUES/)[1].split(',').map(c=>c.trim());
    const row={version:1,updated_at:new Date().toISOString()}; cols.forEach((c,i)=>row[c]=params[i]);
    if (typeof row.data==='string') row.data=JSON.parse(row.data); T.projects.push(row); return [];
  }
  if (s.startsWith('SELECT p.id,p.title,p.version,p.updated_at,m.role')) {
    return T.members.filter(m=>m.user_id===params[0]).map(m=>{
      const p=T.projects.find(p=>p.id===m.project_id);
      const refs=Array.isArray(p.data&&p.data.refs)?p.data.refs:[];
      return {id:p.id,title:p.title,version:p.version,updated_at:p.updated_at,role:m.role,
        total_count:refs.length,
        screened_count:refs.filter(r=>!r.dup&&r.ta&&r.ta.final).length,
        included_count:refs.filter(r=>!r.dup&&r.ft&&r.ft.decision==='include').length,
        member_count:T.members.filter(x=>x.project_id===p.id).length};
    });
  }
  if (s==='SELECT id,title,data,version,updated_at,updated_by FROM projects WHERE id=$1') {
    return T.projects.filter(p=>p.id===params[0]).map(p=>clone(p));
  }
  if (s==='SELECT data,version FROM projects WHERE id=$1') {
    return T.projects.filter(p=>p.id===params[0]).map(p=>({data:clone(p.data),version:p.version}));
  }
  if (s==='SELECT version FROM projects WHERE id=$1')
    return T.projects.filter(p=>p.id===params[0]).map(p=>({version:p.version}));
  if (s==='SELECT title FROM projects WHERE id=$1')
    return T.projects.filter(p=>p.id===params[0]).map(p=>({title:p.title}));
  if (s.startsWith('UPDATE projects SET data=')) {
    const p=T.projects.find(p=>p.id===params[4]); if(p){p.data=JSON.parse(params[0]);p.version=params[1];p.updated_by=params[2];p.title=params[3];p.updated_at=new Date().toISOString();} return [];
  }
  if (s==='DELETE FROM projects WHERE id=$1'){ T.projects=T.projects.filter(p=>p.id!==params[0]); return []; }

  // members
  if (s==='SELECT role FROM members WHERE project_id=$1 AND user_id=$2')
    return T.members.filter(m=>m.project_id===params[0]&&m.user_id===params[1]).map(m=>({role:m.role}));
  if (s.startsWith('INSERT INTO members')) {
    const exists=T.members.find(m=>m.project_id===params[0]&&m.user_id===params[1]);
    if(!exists) T.members.push({project_id:params[0],user_id:params[1],role:params[2]});
    return [];
  }
  if (s.startsWith('SELECT u.id,u.email,u.name,m.role FROM members')) {
    return T.members.filter(m=>m.project_id===params[0]).map(m=>{const u=T.users.find(u=>u.id===m.user_id);return {id:u.id,email:u.email,name:u.name,role:m.role};});
  }
  if (s==='DELETE FROM members WHERE project_id=$1 AND user_id=$2'){ T.members=T.members.filter(m=>!(m.project_id===params[0]&&m.user_id===params[1])); return []; }

  // invites
  if (s==='SELECT token,project_id,role FROM invites WHERE email=$1 AND accepted=false')
    return T.invites.filter(i=>i.email===params[0]&&!i.accepted).map(clone);
  if (s==='SELECT token FROM invites WHERE project_id=$1 AND email=$2 AND accepted=false')
    return T.invites.filter(i=>i.project_id===params[0]&&i.email===params[1]&&!i.accepted).map(i=>({token:i.token}));
  if (s.startsWith('INSERT INTO invites')) {
    T.invites.push({token:params[0],project_id:params[1],email:params[2],role:params[3],invited_by:params[4],accepted:false}); return [];
  }
  if (s==='UPDATE invites SET accepted=true WHERE token=$1'){ const i=T.invites.find(i=>i.token===params[0]); if(i)i.accepted=true; return []; }
  if (s==='SELECT project_id,role FROM invites WHERE token=$1')
    return T.invites.filter(i=>i.token===params[0]).map(i=>({project_id:i.project_id,role:i.role}));
  if (s.startsWith('SELECT email,role FROM invites WHERE project_id=$1'))
    return T.invites.filter(i=>i.project_id===params[0]&&!i.accepted).map(i=>({email:i.email,role:i.role}));

  throw new Error('UNHANDLED QUERY: ' + s);
}

db.setQueryImpl(mockQuery);
db.initSchema = async () => {};   // skip real schema

const { app } = require('./server');

/* ---- minimal HTTP test client with cookie jar ---- */
function makeClient() {
  let cookie = '';
  return function call(method, path, body) {
    return new Promise((resolve, reject) => {
      const data = body ? JSON.stringify(body) : null;
      const req = http.request({ method, path, host: '127.0.0.1', port: PORT,
        headers: Object.assign({ 'Content-Type':'application/json' }, cookie?{Cookie:cookie}:{}, data?{'Content-Length':Buffer.byteLength(data)}:{}) },
        res => { let b=''; res.on('data',d=>b+=d); res.on('end',()=>{
          const sc=res.headers['set-cookie']; if(sc) cookie=sc.map(c=>c.split(';')[0]).join('; ');
          let j={}; try{j=b?JSON.parse(b):{};}catch(e){j={raw:b};}
          resolve({ status: res.statusCode, body: j });
        }); });
      req.on('error', reject);
      if (data) req.write(data); req.end();
    });
  };
}

let PORT, server;
let pass=0, fail=0;
function ok(name, cond){ if(cond){pass++;console.log('  ✓ '+name);} else {fail++;console.log('  ✗ FAIL: '+name);} }

async function run() {
  server = app.listen(0);
  PORT = server.address().port;

  console.log('\n=== AUTH ===');
  const lead = makeClient();
  let r = await lead('POST','/api/auth/register',{email:'lead@uni.edu',name:'Dr Lead',password:'secret123'});
  ok('register lead', r.status===200 && r.body.user.email==='lead@uni.edu');
  r = await lead('POST','/api/auth/register',{email:'lead@uni.edu',password:'secret123'});
  ok('duplicate email rejected', r.status===409);
  r = await lead('GET','/api/me');
  ok('session works (cookie)', r.status===200 && r.body.user.email==='lead@uni.edu');
  ok('new account starts with 50 Viveka AI credits', r.status===200 && r.body.user.aiCredits===50);
  const bad = makeClient();
  r = await bad('POST','/api/auth/login',{email:'lead@uni.edu',password:'wrong'});
  ok('wrong password rejected', r.status===401);
  r = await bad('GET','/api/me');
  ok('no session => 401', r.status===401);

  console.log('\n=== PROJECTS ===');
  r = await lead('POST','/api/projects',{title:'mHealth HTN review', data:{project:{title:'mHealth HTN review',question:'Q'},refs:[{id:'r1',title:'A'}]}});
  ok('create project', r.status===200 && r.body.id);
  const pid = r.body.id;
  r = await lead('GET','/api/projects');
  ok('lists my project', r.status===200 && r.body.projects.length===1 && r.body.projects[0].role==='owner');
  r = await lead('GET','/api/projects/'+pid);
  ok('load project data', r.status===200 && r.body.project.data.refs.length===1 && r.body.role==='owner');
  let version = r.body.project.version;

  console.log('\n=== SAVE / CONCURRENCY ===');
  r = await lead('PUT','/api/projects/'+pid,{version, data:{project:{title:'mHealth HTN review'},refs:[{id:'r1',title:'A',ta:{final:'include'}}]}});
  ok('save bumps version', r.status===200 && r.body.version===version+1);
  // stale save (old version) should conflict
  r = await lead('PUT','/api/projects/'+pid,{version, data:{refs:[]}});
  ok('stale save => 409 conflict', r.status===409 && r.body.currentVersion===version+1);

  console.log('\n=== INVITE + SHARED ACCESS ===');
  // invite a reviewer who hasn't registered yet
  r = await lead('POST','/api/projects/'+pid+'/invite',{email:'student@uni.edu',role:'reviewer'});
  ok('invite created (returns link)', r.status===200 && /invite=/.test(r.body.link));
  const inviteToken = r.body.link.split('invite=')[1];
  // student registers -> should auto-join via pending invite
  const student = makeClient();
  r = await student('POST','/api/auth/register',{email:'student@uni.edu',name:'Asha',password:'pass123'});
  ok('student registers', r.status===200);
  r = await student('GET','/api/projects');
  ok('student auto-joined invited project', r.status===200 && r.body.projects.some(p=>p.id===pid));
  r = await student('GET','/api/projects/'+pid);
  ok('student can load shared project', r.status===200 && r.body.role==='reviewer');
  ok('student sees lead\'s saved decision', r.body.project.data.refs[0].ta && r.body.project.data.refs[0].ta.final==='include');

  console.log('\n=== SHARED EDITING (the Rayyan thing) ===');
  // student saves a change; lead reloads and sees it
  let sv = r.body.project.version;
  r = await student('PUT','/api/projects/'+pid,{version:sv, data:{project:{title:'mHealth HTN review'},refs:[{id:'r1',title:'A',ta:{final:'include'}},{id:'r2',title:'B',ta:{final:'exclude'}}]}});
  ok('student saves to shared project', r.status===200);
  r = await lead('GET','/api/projects/'+pid);
  ok('lead sees student\'s new study (live shared data)', r.body.project.data.refs.length===2 && r.body.project.data.refs[1].ta.final==='exclude');

  console.log('\n=== INVITE EXISTING USER + ACCEPT TOKEN ===');
  const other = makeClient();
  await other('POST','/api/auth/register',{email:'prof@uni.edu',name:'Prof',password:'pass123'});
  r = await lead('POST','/api/projects/'+pid+'/invite',{email:'prof@uni.edu',role:'editor'});
  ok('inviting existing user adds them immediately', r.status===200 && r.body.alreadyUser===true);
  r = await other('GET','/api/projects');
  ok('existing user now sees project', r.body.projects.some(p=>p.id===pid));

  console.log('\n=== MEMBERS + PERMISSIONS ===');
  r = await lead('GET','/api/projects/'+pid+'/members');
  ok('members list shows 3', r.status===200 && r.body.members.length===3);
  // reviewer cannot delete project
  r = await student('DELETE','/api/projects/'+pid);
  ok('reviewer cannot delete project', r.status===403);
  // non-member cannot access
  const outsider = makeClient();
  await outsider('POST','/api/auth/register',{email:'nobody@uni.edu',password:'pass123'});
  r = await outsider('GET','/api/projects/'+pid);
  ok('non-member blocked (403)', r.status===403);

  console.log('\n=== INVITE ACCEPT VIA TOKEN (link click) ===');
  const linkUser = makeClient();
  await linkUser('POST','/api/auth/register',{email:'link@uni.edu',password:'pass123'});
  // simulate a fresh invite + clicking the link
  r = await lead('POST','/api/projects/'+pid+'/invite',{email:'someoneelse@uni.edu',role:'reviewer'});
  const tok2 = r.body.link.split('invite=')[1];
  r = await linkUser('POST','/api/invites/accept',{token:tok2});
  ok('accept invite by token joins project', r.status===200 && r.body.projectId===pid);

  console.log('\n=== INVITE DEDUPE ===');
  r = await lead('POST','/api/projects/'+pid+'/invite',{email:'repeat@uni.edu',role:'reviewer'});
  ok('first invite for pending reviewer created', r.status===200 && /invite=/.test(r.body.link));
  const firstRepeatLink = r.body.link;
  r = await lead('POST','/api/projects/'+pid+'/invite',{email:'repeat@uni.edu',role:'reviewer'});
  ok('second invite reuses existing pending invite', r.status===200 && r.body.pendingAlreadyExists===true && r.body.link===firstRepeatLink);
  r = await lead('GET','/api/projects/'+pid+'/members');
  const repeatPending = (r.body.pending||[]).filter(p => p.email==='repeat@uni.edu');
  ok('pending members list stays deduplicated', repeatPending.length===1);

  console.log('\n=== PASSWORD RESET ===');
  // forgot for a real user — email not configured in test, so devLink is returned
  r = await bad('POST','/api/auth/forgot',{email:'lead@uni.edu'});
  ok('forgot returns ok + devLink (no email configured)', r.status===200 && /reset=/.test(r.body.devLink||''));
  const resetTok = (r.body.devLink||'').split('reset=')[1];
  // forgot for a non-existent user — still ok, but no link (don't reveal existence)
  r = await bad('POST','/api/auth/forgot',{email:'ghost@uni.edu'});
  ok('forgot hides whether email exists', r.status===200 && !r.body.devLink);
  // reset with a too-short password
  r = await bad('POST','/api/auth/reset',{token:resetTok,password:'123'});
  ok('reset rejects weak password', r.status===400);
  // reset properly -> logs in
  const resetClient = makeClient();
  r = await resetClient('POST','/api/auth/reset',{token:resetTok,password:'newpass456'});
  ok('reset succeeds and logs in', r.status===200 && r.body.user.email==='lead@uni.edu');
  // token can't be reused
  r = await bad('POST','/api/auth/reset',{token:resetTok,password:'another789'});
  ok('used reset token rejected', r.status===400);
  // can log in with the NEW password, not the old
  const relog = makeClient();
  r = await relog('POST','/api/auth/login',{email:'lead@uni.edu',password:'newpass456'});
  ok('login works with new password', r.status===200);
  r = await relog('POST','/api/auth/login',{email:'lead@uni.edu',password:'secret123'});
  ok('old password no longer works', r.status===401);

  console.log('\n=== SERVER AI PHASE 1 ===');
  r = await lead('GET','/api/config');
  ok('config reports server AI disabled when no key set', r.status===200 && r.body.aiServerEnabled===false);
  r = await lead('POST','/api/ai/generate',{model:'gemini-flash',prompt:'Return OK',maxTok:16});
  ok('server AI endpoint requires configured provider key', r.status===503 && /not configured/i.test(r.body.error||''));
  r = await lead('GET','/api/me');
  ok('failed AI call does not deduct credits', r.status===200 && r.body.user.aiCredits===50);

  console.log('\n=== SERVER AI PHASE 2 SCREENING ===');
  r = await outsider('POST','/api/projects/'+pid+'/ai/screen',{stage:'ta',refId:'r2'});
  ok('non-member blocked from server-side screening', r.status===403);
  r = await lead('POST','/api/projects/'+pid+'/ai/screen',{stage:'ta',refId:'missing'});
  ok('server-side screening rejects missing study', r.status===404);
  r = await lead('POST','/api/projects/'+pid+'/ai/screen',{stage:'ta',refId:'r2'});
  ok('server-side screening uses configured project and requires provider key', r.status===503 && /not configured/i.test(r.body.error||''));

  console.log('\n=== SERVER AI PHASE 3 EXTRACTION ===');
  r = await lead('GET','/api/projects/'+pid);
  version = r.body.project.version;
  r = await lead('PUT','/api/projects/'+pid,{version, data:{project:{title:'mHealth HTN review',question:'Q',inc:'Adults',exc:'Animal studies'},agent:{advModel:'deepseek'},refs:[{id:'r1',title:'Trial A',abstract:'Randomized trial with 100 adults.',ft:{decision:'include',pdfText:'Methods: randomized controlled trial of 100 adults. Results: systolic blood pressure decreased by 5 mmHg compared with control.'}}]}});
  ok('prepare included full-text study for extraction', r.status===200);
  r = await outsider('POST','/api/projects/'+pid+'/ai/extract',{refId:'r1'});
  ok('non-member blocked from server-side extraction', r.status===403);
  r = await lead('POST','/api/projects/'+pid+'/ai/extract',{refId:'missing'});
  ok('server-side extraction rejects missing study', r.status===404);
  r = await lead('POST','/api/projects/'+pid+'/ai/extract',{refId:'r1'});
  ok('server-side extraction requires configured provider key', r.status===503 && /not configured/i.test(r.body.error||''));
  r = await lead('GET','/api/me');
  ok('failed extraction does not deduct credits', r.status===200 && r.body.user.aiCredits===50);

  console.log('\n=== RATE LIMITING ===');
  const rlc = makeClient();
  let blocked=false;
  for (let i=0;i<12;i++){ const rr=await rlc('POST','/api/auth/login',{email:'rate@uni.edu',password:'x'}); if(rr.status===429){blocked=true;break;} }
  ok('brute-force login gets blocked (429)', blocked);

  server.close();
  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  process.exit(fail?1:0);
}
run().catch(e=>{console.error('TEST CRASH:',e);process.exit(1);});
