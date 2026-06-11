==============================================================
 OMEGA TWEAKS — AFFILIATE BACKEND  (deploy guide)
 Storage: PostgreSQL (Supabase)
==============================================================

WHAT THIS IS
------------
A small web server + a PostgreSQL database (your Supabase project)
that stores affiliate applications, logins, clicks, sales and
payouts in ONE shared place — so every application lands in your
admin panel no matter what device it came from, and data is
PERMANENT across restarts and redeploys.

The web server runs on Render (free). The database is Supabase.
They connect through one env var: DATABASE_URL.

--------------------------------------------------------------
WHAT CHANGED IN v2 (SQLite -> PostgreSQL)
--------------------------------------------------------------
- Removed: better-sqlite3, the local affiliate.db file, the disk,
  and the DB_PATH / SECURE_COOKIES env vars.
- Added: the "pg" driver + a DATABASE_URL env var.
- Tables are created automatically on first boot (initDb()).
- Every API endpoint, request/response shape and auth header is
  EXACTLY THE SAME — the website needs no changes for this.

--------------------------------------------------------------
STEP 1 — GET YOUR SUPABASE CONNECTION STRING
--------------------------------------------------------------
In Supabase: Project -> Settings -> Database -> "Connection string"
-> URI. It looks like:

  postgresql://postgres:[YOUR-PASSWORD]@db.xxxxxxxx.supabase.co:5432/postgres

Replace [YOUR-PASSWORD] with your real DB password.

TIP (recommended for Render): use the "Connection pooling" string
(Transaction mode, port 6543) instead of the direct 5432 one — it
handles more connections on small plans. Either works.

--------------------------------------------------------------
STEP 2 — DEPLOY ON RENDER
--------------------------------------------------------------
Option A — Blueprint (easiest)
  1. Put this "affiliate-backend" folder in your GitHub repo
     (omega-affiliate-backend).
  2. Render -> New + -> "Blueprint" -> pick the repo (reads render.yaml).
  3. Fill the values marked "sync: false":
       DATABASE_URL    -> your Supabase URI from Step 1
       SITE_ORIGIN     -> https://omegatweaks.com
       ADMIN_TOKEN     -> (the SAME secret as the license webhook)
       ADMIN_PASSWORD  -> Messi1987
  4. Apply / Deploy. Wait for "Live".

Option B — manual Web Service
  1. New + -> "Web Service" -> connect the repo.
  2. Runtime: Node.  Build: npm install.  Start: npm start.
  3. Add Environment Variables:
       DATABASE_URL    = (Supabase URI)
       SITE_ORIGIN     = https://omegatweaks.com
       ADMIN_TOKEN     = (same secret as the license webhook)
       ADMIN_PASSWORD  = Messi1987
       COMMISSION_RATE = 0.25
  4. Create Web Service. Wait for "Live".

NO DISK is needed anymore — you can delete the old "affiliate-data"
disk from the service if it still exists.

--------------------------------------------------------------
STEP 3 — VERIFY
--------------------------------------------------------------
Open  <your-backend-url>/   in a browser. You should see:
   {"ok":true,"service":"omega-affiliate-backend","db":"postgres"}

Then in Supabase -> Table editor you'll see the auto-created tables:
  affiliates, clicks, purchases, payouts

The website is already pointed at this backend, so a new application
on https://omegatweaks.com will appear in your admin panel and in the
Supabase "affiliates" table.

--------------------------------------------------------------
WHICH FILES TO REPLACE IN GITHUB (omega-affiliate-backend repo)
--------------------------------------------------------------
Replace these four files with the new versions in this folder:
  server.js        (rewritten for PostgreSQL)
  package.json     (pg instead of better-sqlite3)
  schema.sql       (Postgres types — reference only, auto-created)
  render.yaml      (DATABASE_URL, no disk)
You can also delete any committed affiliate.db file — it's unused now.

--------------------------------------------------------------
ENV VARS (reference)
--------------------------------------------------------------
  DATABASE_URL     required — Supabase Postgres connection string
  SITE_ORIGIN      https://omegatweaks.com  (used for affiliate links + CORS)
  ADMIN_TOKEN      shared secret; MUST match the license webhook
  ADMIN_PASSWORD   admin panel login code (Messi1987)
  COMMISSION_RATE  default 0.25

--------------------------------------------------------------
ENDPOINTS (unchanged from v1)
--------------------------------------------------------------
Public:
  POST /api/affiliates/apply    {name,email,paypal,social,followers,contentType,reason} -> {ok,code}
  POST /api/affiliates/login    {email,password} -> {ok,code,token}
  GET  /api/affiliates/me       -> dashboard payload (X-Omega-Session header)
  POST /api/affiliates/logout
  POST /api/track/click         {ref} -> counts a click

Payment (server-to-server, verify signature!):
  POST /api/webhooks/payment    {ref,pkg,orderId} -> credits commission

Admin (password login -> X-Omega-Admin token; secret never in browser):
  POST /api/admin/login         {password} -> {ok,token}
  GET  /api/admin/check         -> {ok}
  GET  /api/admin/applications?status=pending|approved|rejected
  GET  /api/admin/affiliates    -> approved affiliates with stats
  GET  /api/admin/stats         -> KPI totals
  POST /api/admin/affiliates/:code/approve  {password?} -> {ok,tempPassword,affiliate,link}
  POST /api/admin/affiliates/:code/license  {license}
  POST /api/admin/affiliates/:code/reject
  POST /api/admin/affiliates/:code/payouts  {amount,method?,status?}

--------------------------------------------------------------
SECURITY NOTES (before a big launch)
--------------------------------------------------------------
- Keep your Supabase DB password and DATABASE_URL secret (env vars
  only — never commit them to GitHub).
- The payment webhook MUST verify the Stripe signature before it
  trusts the body (clearly-marked TODO in server.js), or someone
  could fake referral sales.
- Add rate limiting (express-rate-limit) on /apply and /login.
- ADMIN_TOKEN must be identical on this backend and the license
  webhook, or license minting on approval will be rejected.
==============================================================
