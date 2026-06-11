-- ============================================================
--  OMEGA Tweaks — Affiliate backend schema (PostgreSQL / Supabase)
--  REFERENCE ONLY. The server creates these tables automatically
--  on boot (see initDb() in server.js), so you do NOT need to run
--  this by hand. It's here so you can inspect / tweak in the
--  Supabase SQL editor if you want.
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliates (
  id              SERIAL PRIMARY KEY,
  code            TEXT UNIQUE NOT NULL,            -- the ?ref= slug, e.g. "creatorname"
  name            TEXT NOT NULL,
  email           TEXT UNIQUE NOT NULL,
  paypal          TEXT,                            -- PayPal email for payouts
  password_hash   TEXT,                            -- set on approval (bcrypt)
  social          TEXT,
  followers       TEXT,
  content_type    TEXT,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  elite_license   TEXT,                            -- the real Elite key minted on approval
  commission_rate NUMERIC(5,4),                    -- e.g. 0.2500
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clicks (
  id           SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  ip_hash      TEXT,                               -- hashed IP for de-dupe (no raw IP stored)
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_clicks_affiliate ON clicks(affiliate_id);

CREATE TABLE IF NOT EXISTS purchases (
  id           SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  pkg          TEXT NOT NULL,                      -- "OMEGA Lite" | "OMEGA Pro" | "OMEGA Elite"
  price        NUMERIC(10,2) NOT NULL,
  commission   NUMERIC(10,2) NOT NULL,             -- price * commission_rate
  order_ref    TEXT,                               -- payment-provider order id (idempotency)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_purchases_affiliate ON purchases(affiliate_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_purchases_order ON purchases(order_ref);

CREATE TABLE IF NOT EXISTS payouts (
  id           SERIAL PRIMARY KEY,
  affiliate_id INTEGER NOT NULL REFERENCES affiliates(id) ON DELETE CASCADE,
  amount       NUMERIC(10,2) NOT NULL,
  method       TEXT NOT NULL DEFAULT 'PayPal',
  status       TEXT NOT NULL DEFAULT 'Processing', -- Paid | Processing | Pending
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_payouts_affiliate ON payouts(affiliate_id);
