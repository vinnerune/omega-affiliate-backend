/* ============================================================
   OMEGA Tweaks — Affiliate backend (production-ready)
   Node + Express + SQLite.

   Implements the exact contract the frontend calls via
   window.OmegaAffiliate.api.* plus the owner/admin endpoints
   used by affiliate-admin.html.

   Key additions over the reference:
     - Admin logs in with a PASSWORD (ADMIN_PASSWORD) and gets a
       signed session cookie. The admin token is NEVER shipped to
       the browser. Admin routes accept that cookie OR the
       X-Admin-Token header (for curl / server-to-server).
     - CORS is driven by SITE_ORIGIN (your real domain).
     - Commission rate configurable (defaults to 25%).

   Run:  npm install && npm start
   ============================================================ */
const express = require("express");
const cookieParser = require("cookie-parser");
const Database = require("better-sqlite3");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const COMMISSION_RATE = Number(process.env.COMMISSION_RATE || 0.25);
const SITE_ORIGIN = process.env.SITE_ORIGIN || "http://localhost:3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-admin-token";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Messi1987";
const SECURE_COOKIES = String(process.env.SECURE_COOKIES || "true") === "true";
const PRICES = { "OMEGA Lite": 9.95, "OMEGA Pro": 19.95, "OMEGA Elite": 39.95 };

/* ---------- db ---------- */
const db = new Database(process.env.DB_PATH || path.join(__dirname, "affiliate.db"));
db.exec(fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8")
  .replace(/CREATE TABLE /g, "CREATE TABLE IF NOT EXISTS ")
  .replace(/CREATE INDEX /g, "CREATE INDEX IF NOT EXISTS ")
  .replace(/CREATE UNIQUE INDEX /g, "CREATE UNIQUE INDEX IF NOT EXISTS ")
  .replace(/SERIAL PRIMARY KEY/g, "INTEGER PRIMARY KEY AUTOINCREMENT")
  .replace(/TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/g, "TEXT NOT NULL DEFAULT (datetime('now'))")
  .replace(/NUMERIC\(10,2\)/g, "REAL"));

/* ---------- helpers ---------- */
const round = (n) => Math.round(n * 100) / 100;
const slug = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20) || ("creator" + Date.now());
function uniqueCode(base) {
  let code = slug(base), i = 1;
  while (db.prepare("SELECT 1 FROM affiliates WHERE code=?").get(code)) code = slug(base) + i++;
  return code;
}
function hashIp(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0];
  return crypto.createHash("sha256").update(ip + (req.headers["user-agent"] || "")).digest("hex");
}
function sign(value) {
  return crypto.createHmac("sha256", ADMIN_TOKEN).update(value).digest("hex").slice(0, 24);
}
function cookieOpts(extra) {
  return Object.assign({ httpOnly: true, sameSite: "none", secure: SECURE_COOKIES, maxAge: 7 * 864e5 }, extra || {});
}
// affiliate session
function setSession(res, code) {
  res.cookie("omega_sess", code + "." + sign("aff:" + code), cookieOpts());
}
function getSession(req) {
  const v = (req.cookies.omega_sess || "").split(".");
  if (v.length !== 2) return null;
  return v[1] === sign("aff:" + v[0]) ? v[0] : null;
}
// admin session
function setAdminSession(res) {
  res.cookie("omega_admin", "ok." + sign("admin"), cookieOpts());
}
function isAdminSession(req) {
  const v = (req.cookies.omega_admin || "").split(".");
  return v.length === 2 && v[0] === "ok" && v[1] === sign("admin");
}

/* ---------- app ---------- */
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use((req, res, next) => {                       // CORS limited to your site
  res.header("Access-Control-Allow-Origin", SITE_ORIGIN);
  res.header("Access-Control-Allow-Credentials", "true");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-Admin-Token");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/", (req, res) => res.json({ ok: true, service: "omega-affiliate-backend" }));

/* ---------- dashboard payload builder ---------- */
function buildDashboard(a) {
  const purchases = db.prepare("SELECT id, pkg, price, commission, created_at AS date FROM purchases WHERE affiliate_id=? ORDER BY created_at DESC").all(a.id);
  const payouts = db.prepare("SELECT id, amount, method, status, created_at AS date FROM payouts WHERE affiliate_id=? ORDER BY created_at DESC").all(a.id);
  const clicks = db.prepare("SELECT COUNT(*) c FROM clicks WHERE affiliate_id=?").get(a.id).c;
  const earned = round(purchases.reduce((s, p) => s + p.commission, 0));
  const paidOut = round(payouts.filter(p => p.status === "Paid").reduce((s, p) => s + p.amount, 0));
  return {
    code: a.code, name: a.name, status: a.status,
    link: `${SITE_ORIGIN}/?ref=${a.code}`,
    clicks, sales: purchases.length,
    conversion: clicks ? Number((purchases.length / clicks * 100).toFixed(1)) : 0,
    earned, pending: round(earned - paidOut), paidOut,
    purchases, payouts
  };
}

/* ===========================================================
   PUBLIC ENDPOINTS
   =========================================================== */
app.post("/api/affiliates/apply", (req, res) => {
  const f = req.body || {};
  if (!f.name || !f.email) return res.status(400).json({ ok: false, error: "name and email required" });
  // one application per email
  const existing = db.prepare("SELECT code FROM affiliates WHERE lower(email)=lower(?)").get(f.email);
  if (existing) return res.json({ ok: true, code: existing.code, duplicate: true });
  const code = uniqueCode(f.name);
  db.prepare(`INSERT INTO affiliates (code,name,email,paypal,social,followers,content_type,reason,status)
              VALUES (?,?,?,?,?,?,?,?, 'pending')`)
    .run(code, f.name, f.email, f.paypal || "", f.social, f.followers, f.contentType, f.reason);
  res.json({ ok: true, code });
});

app.post("/api/affiliates/login", (req, res) => {
  const { email, password } = req.body || {};
  const a = db.prepare("SELECT * FROM affiliates WHERE lower(email)=lower(?)").get(email || "");
  if (!a || !a.password_hash || !bcrypt.compareSync(password || "", a.password_hash))
    return res.status(401).json({ ok: false, error: "No account found with those details." });
  if (a.status !== "approved") return res.status(403).json({ ok: false, error: "Your application is still under review." });
  setSession(res, a.code);
  res.json({ ok: true, code: a.code });
});

app.get("/api/affiliates/me", (req, res) => {
  const code = getSession(req);
  if (!code) return res.status(401).json({ ok: false, error: "Not logged in." });
  const a = db.prepare("SELECT * FROM affiliates WHERE code=?").get(code);
  if (!a) return res.status(404).json({ ok: false });
  res.json(buildDashboard(a));
});

app.post("/api/affiliates/logout", (req, res) => { res.clearCookie("omega_sess", cookieOpts()); res.json({ ok: true }); });

app.post("/api/track/click", (req, res) => {
  const ref = (req.body && req.body.ref) || "";
  const a = db.prepare("SELECT * FROM affiliates WHERE code=? AND status='approved'").get(ref);
  if (!a) return res.json({ ok: false });
  const iph = hashIp(req);
  const recent = db.prepare("SELECT 1 FROM clicks WHERE affiliate_id=? AND ip_hash=? AND created_at > datetime('now','-6 hours')").get(a.id, iph);
  if (!recent) db.prepare("INSERT INTO clicks (affiliate_id, ip_hash, user_agent) VALUES (?,?,?)").run(a.id, iph, req.headers["user-agent"] || "");
  res.cookie("omega_ref", ref, { httpOnly: false, sameSite: "lax", maxAge: 30 * 864e5 });
  res.json({ ok: true });
});

/* ===========================================================
   PAYMENT WEBHOOK  — credit commission from a verified payment.
   VERIFY THE PROVIDER SIGNATURE before trusting req.body.
   =========================================================== */
app.post("/api/webhooks/payment", (req, res) => {
  const { ref, pkg, orderId } = req.body || {};
  const price = PRICES[pkg];
  const a = ref && price && db.prepare("SELECT * FROM affiliates WHERE code=? AND status='approved'").get(ref);
  if (!a) return res.json({ ok: false, reason: "no-valid-ref" });
  try {
    db.prepare("INSERT INTO purchases (affiliate_id,pkg,price,commission,order_ref) VALUES (?,?,?,?,?)")
      .run(a.id, pkg, price, round(price * COMMISSION_RATE), orderId || crypto.randomUUID());
  } catch (e) { /* duplicate orderId -> already credited */ }
  res.json({ ok: true });
});

/* ===========================================================
   ADMIN AUTH  — password login -> signed cookie (no token in browser)
   =========================================================== */
app.post("/api/admin/login", (req, res) => {
  const pw = (req.body && req.body.password) || "";
  if (pw !== ADMIN_PASSWORD) return res.status(401).json({ ok: false, error: "Incorrect access code." });
  setAdminSession(res);
  res.json({ ok: true });
});
app.post("/api/admin/logout", (req, res) => { res.clearCookie("omega_admin", cookieOpts()); res.json({ ok: true }); });
app.get("/api/admin/check", (req, res) => res.json({ ok: isAdminSession(req) }));

function admin(req, res, next) {
  if (isAdminSession(req) || req.headers["x-admin-token"] === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok: false });
}

app.get("/api/admin/applications", admin, (req, res) => {
  const status = req.query.status || "pending";
  res.json(db.prepare("SELECT code,name,email,paypal,social,followers,content_type AS contentType,reason,status,created_at FROM affiliates WHERE status=? ORDER BY created_at DESC").all(status));
});
app.post("/api/admin/affiliates/:code/approve", admin, (req, res) => {
  const pw = (req.body && req.body.password) || crypto.randomBytes(6).toString("hex");
  const info = db.prepare("UPDATE affiliates SET status='approved', password_hash=? WHERE code=?")
    .run(bcrypt.hashSync(pw, 10), req.params.code);
  const a = db.prepare("SELECT code,name,email,paypal FROM affiliates WHERE code=?").get(req.params.code);
  res.json({ ok: info.changes > 0, tempPassword: pw, affiliate: a, link: `${SITE_ORIGIN}/?ref=${req.params.code}` });
});
app.post("/api/admin/affiliates/:code/reject", admin, (req, res) => {
  const info = db.prepare("UPDATE affiliates SET status='rejected' WHERE code=?").run(req.params.code);
  res.json({ ok: info.changes > 0 });
});
app.post("/api/admin/affiliates/:code/payouts", admin, (req, res) => {
  const a = db.prepare("SELECT id FROM affiliates WHERE code=?").get(req.params.code);
  if (!a) return res.status(404).json({ ok: false });
  const { amount, method = "PayPal", status = "Processing" } = req.body || {};
  db.prepare("INSERT INTO payouts (affiliate_id,amount,method,status) VALUES (?,?,?,?)").run(a.id, amount, method, status);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Affiliate API on :${PORT}  (site origin: ${SITE_ORIGIN})`));
