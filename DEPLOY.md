# Pramana - Hosting & Collaboration Setup (step by step, no developer needed)

This turns Pramana into a real shared tool: people make accounts, log in, and
collaborate on the same review live (like Rayyan). Budget: about Rs 420-500/month.

You will set up three things:
1. **Railway** - runs the server + database (the paid part, ~$5/mo).
2. **Brevo** - sends invite emails (free).
3. **Google sign-in** - optional, lets people log in with Google.

You do NOT need to write code. You'll copy files and click buttons.

---

## What's in this folder
- `server.js`, `db.js`, `package.json` - the backend (don't edit).
- `public/index.html` - **replace this** with the Pramana app file (see Step 5).
- `.env.example` - the settings template.
- `railway.json` - tells Railway how to run it.

---

## STEP 1 - Put this folder on GitHub (15 min, free)
Railway deploys from GitHub.

1. Make a free account at https://github.com
2. Click **+ -> New repository**. Name it `pramana-server`. Keep it **Private**. Create.
3. On the new repo page, click **uploading an existing file**.
4. Drag in EVERYTHING in this folder **except** the `node_modules` folder and `.env`
   (just: `server.js`, `db.js`, `package.json`, `package-lock.json`, `railway.json`,
   `.gitignore`, `.env.example`, and the `public` folder).
5. Click **Commit changes**.

---

## STEP 2 - Deploy on Railway (10 min)
1. Go to https://railway.app and sign up with your GitHub account.
2. Click **New Project -> Deploy from GitHub repo ->** pick `pramana-server`.
3. Railway starts building. It will fail the first time because there's no database yet - that's expected.
4. In your project, click **+ New -> Database -> PostgreSQL**. Railway creates it and
   automatically provides `DATABASE_URL` to your server.
5. Click your **server service -> Variables -> + New Variable** and add:
   - `JWT_SECRET` -> a long random string. (Make one: on any computer with Node, run
     `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`, or just
     mash a very long random mix of letters/numbers.)
   - `APP_URL` -> leave for now; you'll fill it after Step 3.
   - `NODE_ENV` -> `production`
6. Click **Settings -> Networking -> Generate Domain**. Copy the URL
   (e.g. `https://pramana-production.up.railway.app`).
7. Go back to **Variables**, set `APP_URL` to that URL. Railway redeploys.
8. Open the URL - you should see "Pramana server is running ✓".

**Cost:** Railway's Hobby plan is ~$5/month and covers this easily. Add a payment method
when prompted. The Postgres database is included in that.

---

## STEP 3 - Brevo email for invites (15 min, free)
Invites work without this (you can copy a link), but email is nicer.

1. Sign up at https://www.brevo.com (free: 300 emails/day).
2. Go to **SMTP & API -> SMTP**. You'll see:
   - Server: `smtp-relay.brevo.com`, Port: `587`
   - **Login** (an email) and an **SMTP key** (click *Generate a new SMTP key*).
3. In Railway -> your server -> **Variables**, add:
   - `SMTP_HOST` = `smtp-relay.brevo.com`
   - `SMTP_PORT` = `587`
   - `SMTP_USER` = your Brevo login
   - `SMTP_PASS` = the SMTP key
   - `SMTP_FROM` = `Pramana <no-reply@yourdomain.com>` (use any email you control;
     for best delivery, verify a sender in Brevo under **Senders**).
4. Railway redeploys. Invites now email a join link.

---

## STEP 4 - Google sign-in (optional, 15 min)
Skip this if email+password is enough.

1. Go to https://console.cloud.google.com -> create a project.
2. **APIs & Services -> OAuth consent screen** -> External -> fill app name + your email -> Save.
3. **Credentials -> + Create Credentials -> OAuth client ID -> Web application.**
4. Under **Authorized JavaScript origins**, add your Railway URL (from Step 2.6).
5. Copy the **Client ID**. In Railway -> Variables, add `GOOGLE_CLIENT_ID` = that value.
6. Railway redeploys. A "Sign in with Google" button appears automatically.

---

## STEP 5 - Put the Pramana app in
1. Take the Pramana app file (`Pramana-SRMA.html`).
2. Rename it to `index.html`.
3. On GitHub, open the `public` folder -> **Add file -> Upload files** -> drop in `index.html`
   (replace the placeholder) -> **Commit**.
4. Railway redeploys. Your Railway URL now serves the full app, backed by accounts + sharing.

---

## STEP 6 - Use it
- Share your Railway URL with your students.
- Everyone clicks **Create account** (email+password or Google).
- Open a project -> **Invite** -> type a student's email -> they get a link / email -> they join -> you all screen the same project live.

---

## Money summary
| Item | Cost |
|---|---|
| Railway Hobby (server + Postgres) | ~$5/mo (~Rs 420) |
| Brevo email | Free (300/day) |
| Google sign-in | Free |
| Domain (optional) | ~Rs 800/year |
| **Total** | **~Rs 420-500/month** |

---

## If something breaks
- **Server won't start / "DATABASE_URL" errors** -> make sure the Postgres plugin is added (Step 2.4) and the server redeployed after.
- **Invites don't email** -> check the four `SMTP_*` variables; the join link still works via copy-paste regardless.
- **Google button missing** -> `GOOGLE_CLIENT_ID` not set, or the Railway URL isn't in "Authorized JavaScript origins".
- **"conflict / please refresh" when saving** -> two people saved at once; reload to get the latest, then redo your change. (This is the safety net that prevents overwriting each other.)

When you hit a wall, tell me the exact error text and which step - that's the fastest way for me to help.
