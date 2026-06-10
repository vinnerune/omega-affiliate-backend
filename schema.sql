-- ============================================================
--  OMEGA Tweaks — Affiliate backend schema
--  Written for SQLite (the server runs it through small regex
--  swaps so the same file also reads as Postgres-ish). For a real
--  Postgres deploy, change types per the comments.
-- ============================================================

-- Approved & pending creators
CREATE TABLE affiliates (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT UNIQUE NOT NULL,          -- the ?ref= slug, e.g. "creatorname"
  name          TEXT NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  paypal        TEXT,                          -- PayPal email for payouts
  password_hash TEXT,                          -- set on approval (bcrypt)
  social        TEXT,
  followers     TEXT,                          -- stored as the selected range
  content_type  TEXT,
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',-- pending | approved | rejected
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per attributed referral click
CREATE TABLE clicks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  ip_hash      TEXT,                           -- hashed IP for de-dupe (don't store raw IP)
  user_agent   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_clicks_affiliate ON clicks(affiliate_id);

-- One row per attributed sale (written from a verified payment webhook)
CREATE TABLE purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id  INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  pkg           TEXT NOT NULL,                 -- "OMEGA Lite" | "OMEGA Pro" | "OMEGA Elite"
  price         REAL NOT NULL,
  commission    REAL NOT NULL,                 -- price * COMMISSION_RATE
  order_ref     TEXT,                          -- payment-provider order id (idempotency)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_purchases_affiliate ON purchases(affiliate_id);
CREATE UNIQUE INDEX idx_purchases_order ON purchases(order_ref);

-- Payout history, managed by the owner
CREATE TABLE payouts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  affiliate_id  INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount        REAL NOT NULL,
  method        TEXT NOT NULL DEFAULT 'PayPal',
  status        TEXT NOT NULL DEFAULT 'Processing', -- Paid | Processing | Pending
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_payouts_affiliate ON payouts(affiliate_id);
