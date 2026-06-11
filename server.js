/* ============================================================
   OMEGA Tweaks — Affiliate backend (production-ready)
   Node + Express + PostgreSQL (Supabase / any Postgres).

   Implements the exact contract the frontend calls via
   window.OmegaAffiliate.api.* plus the owner/admin endpoints
   used by affiliate-admin.html.

   Storage:
     - Uses DATABASE_URL (Supabase connection string).
     - Tables are created automatically on boot if missing.
     - Data is permanent (unlike the old SQLite-on-free-disk setup).

   Auth:
     - Admin logs in with ADMIN_PASSWORD and gets a signed header
       token (X-Omega-Admin). The token secret (ADMIN_TOKEN) never
       ships to the browser. Admin routes also accept the
       X-Admin-Token header (for curl / server-to-server).
     - CORS echoes the request origin (so www / non-www both work).
     - Commission rate configurable (defaults to 25%).

   Run:  npm install && npm start
   Env:  DATABASE_URL (required), ADMIN_PASSWORD, ADMIN_TOKEN,
         SITE_ORIGIN, COMMISSION_RATE
   ============================================================ */
const express = require("express");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.25);
const SITE_ORIGIN = process.env.SITE_ORIGIN || "http://localhost:3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-admin-token";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Messi1987";
const PRICES = { "OMEGA Lite": 9.95, "OMEGA Pro": 19.95, "OMEGA Elite": 39.95 };
const ELITE_DOWNLOAD = SITE_ORIGIN + "/downloads/OMEGA-Tweaks.zip";

if (!process.env.DATABASE_URL) {
  console.error("FATAL: DATABASE_URL is not set. Add your Supabase connection string as an env var.");
  process.exit(1);
}

/* ---------- db (PostgreSQL) ---------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Supabase requires SSL; this works on Render without bundling a CA file.
  ssl: { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30000
});

// tiny query helper: q(text, params) -> { rows, rowCount }
const q = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const all = async (text, params) => (await pool.query(text, params)).rows;

async function initDb() {
  await q(`
    CREATE TABLE IF NOT EXISTS affiliates (
      id              SERIAL PRIMARY KEY,
      code            TEXT UNIQUE NOT NULL,
      name            TEXT NOT NULL,
      email           TEXT UNIQUE NOT NULL,
      paypal          TEXT,
      password_hash   TEXT,
      social          TEXT,
      followers       TEXT,
      content_type    TEXT,
      reason          TEXT,
      status          TEXT NOT NULL DEFAULT 'pending',
      elite_license   TEXT,
      commission_rate NUMERIC(5,4),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id           SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      ip_hash      TEXT,
      user_agent   TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_affiliate ON clicks(affiliate_id);
    CREATE TABLE IF NOT EXISTS purchases (
      id           SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      pkg          TEXT NOT NULL,
      price        NUMERIC(10,2) NOT NULL,
      commission   NUMERIC(10,2) NOT NULL,
      order_ref    TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_purchases_affiliate ON purchases(affiliate_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_order ON purchases(order_ref);
    CREATE TABLE IF NOT EXISTS payouts (
      id           SERIAL PRIMARY KEY,
      affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
      amount       NUMERIC(10,2) NOT NULL,
      method       TEXT NOT NULL DEFAULT 'PayPal',
      status       TEXT NOT NULL DEFAULT 'Processing',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payouts_affiliate ON payouts(affiliate_id);
  `);
  // migrations for older databases (no-op if the column already exists)
  await q(`ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS elite_license TEXT`);
  await q(`ALTER TABLE affiliates ADD COLUMN IF NOT EXISTS commission_rate NUMERIC(5,4)`);
  console.log("DB ready (PostgreSQL).");
}

/* ---------- helpers ---------- */
const round = (n) => Math.round(Number(n) * 100) / 100;
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || ("creator" + Date.now());
async function uniqueCode(base) {
  let code = slug(base), i = 1;
  while (await one("SELECT 1 FROM affiliates WHERE code=$1", [code])) code = slug(base) + i++;
  return code;
}
function hashIp(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  return crypto.createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex");
}
function sign(value) {
  return crypto.createHmac("sha256", ADMIN_TOKEN).update(value).digest("hex").slice(0, 24);
}
// affiliate session — token returned to the client, sent back in a header
function affToken(code) { return code + "." + sign("aff:" + code); }
function getSession(req) {
  const v = (req.headers["x-omega-session"] || "").split(".");
  if (v.length !== 2) return null;
  return v[1] === sign("aff:" + v[0]) ? v[0] : null;
}
// admin session — same header-token approach
function adminToken() { return "admin." + sign("admin"); }
function isAdminSession(req) {
  const v = (req.headers["x-omega-admin"] || "").split(".");
  return v.length === 2 && v[0] === "admin" && v[1] === sign("admin");
}

/* ---------- app ---------- */
const app = express();
app.use(express.json());
app.use((req, res, next) => {                       // CORS — token auth, echo origin
  const origin = req.headers.origin;
  res.header("Access-Control-Allow-Origin", origin || SITE_ORIGIN);
  res.header("Vary", "Origin");
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token, X-Omega-Session, X-Omega-Admin");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// small async wrapper so a thrown error becomes a clean 500 instead of a crash
const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("[OMEGA] route error:", req.method, req.path, err.message);
  if (!res.headersSent) res.status(500).json({ ok: false, error: "Server error." });
});

app.get("/", (req, res) => res.json({ ok: true, service: "omega-affiliate-backend", db: "postgres" }));

/* ---------- dashboard payload builder ---------- */
async function buildDashboard(a) {
  const purchases = await all("SELECT id, pkg, price::float8 AS price, commission::float8 AS commission, created_at AS date FROM purchases WHERE affiliate_id=$1 ORDER BY created_at DESC", [a.id]);
  const payouts = await all("SELECT id, amount::float8 AS amount, method, status, created_at AS date FROM payouts WHERE affiliate_id=$1 ORDER BY created_at DESC", [a.id]);
  const clicks = Number((await one("SELECT COUNT(*)::int AS c FROM clicks WHERE affiliate_id=$1", [a.id])).c);
  const earned = round(purchases.reduce((s, p) => s + Number(p.commission), 0));
  const paidOut = round(payouts.filter(p => p.status === "Paid").reduce((s, p) => s + Number(p.amount), 0));
  return {
    code: a.code, name: a.name, status: a.status,
    link: `${SITE_ORIGIN}/?ref=${a.code}`,
    paypal: a.paypal || a.email,
    commissionRate: (a.commission_rate != null ? Number(a.commission_rate) : COMMISSION_RATE),
    elite: a.elite_license ? { license: a.elite_license } : null,
    eliteDownload: ELITE_DOWNLOAD,
    createdAt: a.created_at,
    clicks, sales: purchases.length,
    conversion: clicks ? Number((purchases.length / clicks * 100).toFixed(1)) : 0,
    earned, pending: round(earned - paidOut), paidOut,
    purchases, payouts
  };
}

/* ===========================================================
   PUBLIC ENDPOINTS
   =========================================================== */
app.post("/api/affiliates/apply", wrap(async (req, res) => {
  const f = req.body || {};
  if (!f.name || !f.email) return res.status(400).json({ ok: false, error: "name and email required" });
  const existing = await one("SELECT code FROM affiliates WHERE lower(email)=lower($1)", [f.email]);
  if (existing) return res.json({ ok: true, code: existing.code, duplicate: true });
  const code = await uniqueCode(f.name);
  await q(`INSERT INTO affiliates (code,name,email,paypal,social,followers,content_type,reason,status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
    [code, f.name, f.email, f.paypal || "", f.social, f.followers, f.contentType, f.reason]);
  res.json({ ok: true, code });
}));

app.post("/api/affiliates/login", wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const a = await one("SELECT * FROM affiliates WHERE lower(email)=lower($1)", [email || ""]);
  if (!a || !a.password_hash || !bcrypt.compareSync(password || "", a.password_hash))
    return res.status(401).json({ ok: false, error: "No account found with those details." });
  if (a.status !== "approved") return res.status(403).json({ ok: false, error: "Your application is still under review." });
  res.json({ ok: true, code: a.code, token: affToken(a.code) });
}));

app.get("/api/affiliates/me", wrap(async (req, res) => {
  const code = getSession(req);
  if (!code) return res.status(401).json({ ok: false, error: "Not logged in." });
  const a = await one("SELECT * FROM affiliates WHERE code=$1", [code]);
  if (!a) return res.status(404).json({ ok: false });
  res.json(await buildDashboard(a));
}));

app.post("/api/affiliates/logout", (req, res) => { res.json({ ok: true }); });

app.post("/api/track/click", wrap(async (req, res) => {
  const ref = (req.body && req.body.ref) || "";
  const a = await one("SELECT * FROM affiliates WHERE code=$1 AND status='approved'", [ref]);
  if (!a) return res.json({ ok: false });
  const iph = hashIp(req);
  const recent = await one("SELECT 1 FROM clicks WHERE affiliate_id=$1 AND ip_hash=$2 AND created_at > NOW() - INTERVAL '6 hours'", [a.id, iph]);
  if (!recent) await q("INSERT INTO clicks (affiliate_id, ip_hash, user_agent) VALUES ($1,$2,$3)", [a.id, iph, req.headers["user-agent"] || ""]);
  res.json({ ok: true });
}));

/* ===========================================================
   PAYMENT WEBHOOK  — credit commission from a verified payment.
   VERIFY THE PROVIDER SIGNATURE before trusting req.body.
   =========================================================== */
app.post("/api/webhooks/payment", wrap(async (req, res) => {
  const { ref, pkg, orderId } = req.body || {};
  const price = PRICES[pkg];
  if (!ref || !price) return res.json({ ok: false, reason: "no-valid-ref" });
  const a = await one("SELECT * FROM affiliates WHERE code=$1 AND status='approved'", [ref]);
  if (!a) return res.json({ ok: false, reason: "no-valid-ref" });
  try {
    await q("INSERT INTO purchases (affiliate_id,pkg,price,commission,order_ref) VALUES ($1,$2,$3,$4,$5)",
      [a.id, pkg, price, round(price * COMMISSION_RATE), orderId || crypto.randomUUID()]);
  } catch (e) { /* duplicate orderId -> already credited */ }
  res.json({ ok: true });
}));

/* ===========================================================
   ADMIN AUTH  — password login -> signed header token
   =========================================================== */
app.post("/api/admin/login", (req, res) => {
  const pw = (req.body && req.body.password) || "";
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Incorrect access code." });
  res.json({ ok: true, token: adminToken() });
});
app.post("/api/admin/logout", (req, res) => { res.json({ ok: true }); });
app.get("/api/admin/check", (req, res) => res.json({ ok: isAdminSession(req) }));

function admin(req, res, next) {
  if (isAdminSession(req) || req.headers["x-admin-token"] === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false });
}

app.get("/api/admin/applications", admin, wrap(async (req, res) => {
  const status = req.query.status || "pending";
  res.json(await all(`SELECT code,name,email,paypal,social,followers,content_type AS "contentType",reason,status,created_at
                      FROM affiliates WHERE status=$1 ORDER BY created_at DESC`, [status]));
}));

app.post("/api/admin/affiliates/:code/approve", admin, wrap(async (req, res) => {
  const pw = (req.body && req.body.password) || crypto.randomBytes(6).toString("hex");
  const r = await q("UPDATE affiliates SET status='approved', password_hash=$1, commission_rate=COALESCE(commission_rate, $2) WHERE code=$3",
    [bcrypt.hashSync(pw, 10), COMMISSION_RATE, req.params.code]);
  const a = await one("SELECT code,name,email,paypal FROM affiliates WHERE code=$1", [req.params.code]);
  res.json({ ok: r.rowCount > 0, tempPassword: pw, affiliate: a, eliteDownload: ELITE_DOWNLOAD, link: `${SITE_ORIGIN}/?ref=${req.params.code}` });
}));

// store the REAL Elite license (minted by the license webhook) on the affiliate
app.post("/api/admin/affiliates/:code/license", admin, wrap(async (req, res) => {
  const lic = (req.body && req.body.license) || "";
  if (!lic) return res.status(400).json({ ok: false, error: "license required" });
  const r = await q("UPDATE affiliates SET elite_license=$1 WHERE code=$2", [lic, req.params.code]);
  res.json({ ok: r.rowCount > 0 });
}));

// approved affiliates WITH full stats (for the admin table)
app.get("/api/admin/affiliates", admin, wrap(async (req, res) => {
  const list = await all("SELECT * FROM affiliates WHERE status='approved' ORDER BY created_at DESC");
  const out = [];
  for (const a of list) out.push(Object.assign(await buildDashboard(a), { email: a.email, paypal: a.paypal || a.email, createdAt: a.created_at }));
  res.json(out);
}));

// dashboard totals for the admin KPI cards
app.get("/api/admin/stats", admin, wrap(async (req, res) => {
  const pending = Number((await one("SELECT COUNT(*)::int AS c FROM affiliates WHERE status='pending'")).c);
  const affiliates = Number((await one("SELECT COUNT(*)::int AS c FROM affiliates WHERE status='approved'")).c);
  const sales = Number((await one("SELECT COUNT(*)::int AS c FROM purchases")).c);
  const earned = Number((await one("SELECT COALESCE(SUM(commission),0)::float8 AS s FROM purchases")).s);
  const paid = Number((await one("SELECT COALESCE(SUM(amount),0)::float8 AS s FROM payouts WHERE status='Paid'")).s);
  res.json({ pending, affiliates, sales, owed: round(earned - paid) });
}));

app.post("/api/admin/affiliates/:code/reject", admin, wrap(async (req, res) => {
  const r = await q("UPDATE affiliates SET status='rejected' WHERE code=$1", [req.params.code]);
  res.json({ ok: r.rowCount > 0 });
}));

app.post("/api/admin/affiliates/:code/payouts", admin, wrap(async (req, res) => {
  const a = await one("SELECT id FROM affiliates WHERE code=$1", [req.params.code]);
  if (!a) return res.status(404).json({ ok: false });
  const { amount, method = "PayPal", status = "Processing" } = req.body || {};
  await q("INSERT INTO payouts (affiliate_id,amount,method,status) VALUES ($1,$2,$3,$4)", [a.id, amount, method, status]);
  res.json({ ok: true });
}));

const PORT = process.env.PORT || 4000;
initDb()
  .then(() => app.listen(PORT, () => console.log(`Affiliate API on :${PORT}  (site origin: ${SITE_ORIGIN})`)))
  .catch((err) => { console.error("FATAL: could not initialize the database:", err.message); process.exit(1); });
