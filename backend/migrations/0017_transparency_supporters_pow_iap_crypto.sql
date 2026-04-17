-- 0017: Transparency reports, supporters wall metadata, crypto checkout, and app-store receipt tracking

ALTER TABLE users ADD COLUMN donor_recurring INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN donor_since INTEGER;

CREATE INDEX IF NOT EXISTS idx_users_donor_wall ON users(donor_tier, donor_recurring, donor_since);

CREATE TABLE IF NOT EXISTS transparency_reports (
  id TEXT PRIMARY KEY,
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  published_at INTEGER NOT NULL DEFAULT (unixepoch()),
  requests_received INTEGER NOT NULL DEFAULT 0,
  requests_complied INTEGER NOT NULL DEFAULT 0,
  accounts_affected INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  signed_by TEXT NOT NULL DEFAULT 'RocChat Team'
);

CREATE INDEX IF NOT EXISTS idx_transparency_published ON transparency_reports(published_at DESC);

CREATE TABLE IF NOT EXISTS crypto_checkout_intents (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  checkout_type TEXT NOT NULL CHECK (checkout_type IN ('donation', 'business')),
  amount_usd_cents INTEGER NOT NULL,
  crypto_symbol TEXT NOT NULL DEFAULT 'USDC',
  amount_crypto TEXT NOT NULL,
  wallet_address TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'expired', 'failed')),
  tx_hash TEXT,
  recurring INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  confirmed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_crypto_intents_user ON crypto_checkout_intents(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_crypto_intents_status ON crypto_checkout_intents(status, created_at DESC);

CREATE TABLE IF NOT EXISTS app_store_receipts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('apple', 'google')),
  product_id TEXT NOT NULL,
  original_tx_id TEXT,
  purchase_token TEXT,
  receipt_payload TEXT NOT NULL,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_apple_unique ON app_store_receipts(platform, original_tx_id) WHERE original_tx_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_receipts_google_unique ON app_store_receipts(platform, purchase_token) WHERE purchase_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_receipts_user ON app_store_receipts(user_id, created_at DESC);
