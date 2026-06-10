==============================================================
 OMEGA TWEAKS — AFFILIATE BACKEND  (deploy guide)
==============================================================

WHAT THIS IS
------------
A small web server + database that stores affiliate applications,
logins, clicks and sales in ONE shared place. Without it, the
affiliate data lives only in each person's browser — which is why
an application your friend submitted never showed up in YOUR admin
panel. Once this is deployed and connected, every application lands
in your admin panel no matter what device it came from.

This must run on a HOST (it cannot live on normal web hosting next
to index.html). You already use Render for the license-webhook, so
deploy it there too. It's free.

--------------------------------------------------------------
WHAT YOU NEED TO DECIDE FIRST
--------------------------------------------------------------
- SITE_ORIGIN  = your real website address, no trailing slash.
                 e.g.  https://omegatweaks.com
                 (Must be the EXACT https origin the site is served
                  from, or logins/cookies won't work.)
- ADMIN_PASSWORD = the code you type to open the admin panel.
                   Currently: Messi1987
- ADMIN_TOKEN   = a long random secret (Render can generate it).

--------------------------------------------------------------
DEPLOY ON RENDER  (Option A — Blueprint, easiest)
--------------------------------------------------------------
1. Put this "affiliate-backend" folder in a GitHub repo
   (it can be its own repo, or a subfolder of one).
2. Render Dashboard -> New + -> "Blueprint".
3. Pick the repo. Render reads render.yaml and creates the service
   with a 1 GB persistent disk (needed so the database survives
   restarts).
4. When prompted, fill the two values marked "sync: false":
     SITE_ORIGIN     -> https://yourdomain.com
     ADMIN_PASSWORD  -> Messi1987   (or your own)
5. Click Apply / Deploy. Wait for "Live".
6. Copy the service URL, e.g.
     https://omega-affiliate-backend.onrender.com

DEPLOY ON RENDER  (Option B — manual, if you don't use Blueprints)
--------------------------------------------------------------
1. New + -> "Web Service" -> connect the repo / this folder.
2. Runtime: Node.  Build: npm install.  Start: npm start.
3. Add a DISK: Name "affiliate-data", Mount path "/data", 1 GB.
4. Add Environment Variables:
     DB_PATH         = /data/affiliate.db
     SITE_ORIGIN     = https://yourdomain.com
     ADMIN_PASSWORD  = Messi1987
     ADMIN_TOKEN     = (any long random string)
     COMMISSION_RATE = 0.25
     SECURE_COOKIES  = true
5. Create Web Service. Wait for "Live", copy the URL.

--------------------------------------------------------------
AFTER IT'S LIVE  (this is the part I (Claude) finish for you)
--------------------------------------------------------------
Send me the live backend URL. I will:
  - set it as API_BASE on the apply, dashboard and admin pages,
  - switch those pages from browser-only storage to the server,
  - re-test and hand you an updated production ZIP.

Quick self-test you can run once it's live (in a browser):
  Open  <your-backend-url>/        -> should show {"ok":true,...}

--------------------------------------------------------------
ENDPOINTS (reference)
--------------------------------------------------------------
Public:
  POST /api/affiliates/apply    {name,email,paypal,social,followers,contentType,reason} -> {ok,code}
  POST /api/affiliates/login    {email,password} -> {ok,code} (+session cookie)
  GET  /api/affiliates/me       -> dashboard payload (needs session cookie)
  POST /api/affiliates/logout
  POST /api/track/click         {ref} -> counts a click

Payment (server-to-server, verify signature!):
  POST /api/webhooks/payment    {ref,pkg,orderId} -> credits commission

Admin (password login -> cookie; no token in the browser):
  POST /api/admin/login         {password} -> {ok} (+admin cookie)
  GET  /api/admin/check         -> {ok}
  GET  /api/admin/applications?status=pending|approved|rejected
  POST /api/admin/affiliates/:code/approve  {password?} -> {ok,tempPassword,affiliate,link}
  POST /api/admin/affiliates/:code/reject
  POST /api/admin/affiliates/:code/payouts  {amount,method?,status?}

--------------------------------------------------------------
SECURITY NOTES (before a big launch)
--------------------------------------------------------------
- Admin auth here is a single shared password -> signed cookie. Fine
  for a solo owner; upgrade to per-user accounts if you add staff.
- The payment webhook MUST verify the Stripe signature before it
  trusts the body (left as a clearly-marked TODO in server.js), or
  someone could fake referral sales.
- Add rate limiting (express-rate-limit) on /apply and /login.
- For higher volume, move from SQLite to Postgres (schema is portable).
==============================================================
