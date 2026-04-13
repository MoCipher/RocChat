-- RocChat D1 Schema — Initial Migration
-- All sensitive data is encrypted client-side. Server stores ciphertext only.

-- Users: no email, no phone, just UUID + username + auth hash
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, -- UUID
  username TEXT NOT NULL UNIQUE,
  display_name TEXT, -- can be encrypted by client
  auth_hash TEXT NOT NULL, -- PBKDF2/Argon2 hash (base64)
  salt TEXT NOT NULL, -- base64
  encrypted_keys TEXT NOT NULL, -- AES-GCM encrypted private key blob (base64)
  identity_key TEXT NOT NULL, -- Ed25519 public key (base64)
  identity_dh_key TEXT NOT NULL, -- X25519 public key for X3DH (base64)
  discoverable INTEGER NOT NULL DEFAULT 1, -- 0 = hidden from search
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Signed Pre-Keys (rotated periodically)
CREATE TABLE IF NOT EXISTS signed_pre_keys (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, -- base64
  signature TEXT NOT NULL, -- base64 Ed25519 signature
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, id)
);

-- One-Time Pre-Keys (consumed on first message)
CREATE TABLE IF NOT EXISTS one_time_pre_keys (
  id INTEGER NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  public_key TEXT NOT NULL, -- base64
  used INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, id)
);

-- Devices
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, -- device UUID
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_name TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web', 'desktop')),
  push_token TEXT, -- encrypted push token
  last_active INTEGER NOT NULL DEFAULT (unixepoch()),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);

-- Conversations
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, -- UUID
  type TEXT NOT NULL CHECK (type IN ('direct', 'group')),
  encrypted_meta TEXT, -- AES-GCM encrypted group metadata (name, avatar, etc.)
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Conversation members (maps users to conversations)
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'moderator', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (conversation_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members(user_id);

-- Messages (encrypted blobs — server cannot read content)
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, -- UUID
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  -- Encrypted Double Ratchet payload
  encrypted TEXT NOT NULL, -- JSON: { header, ciphertext, iv, tag }
  server_timestamp INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER -- for disappearing messages (NULL = no expiry)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, server_timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;

-- Contacts (who has added whom)
CREATE TABLE IF NOT EXISTS contacts (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified INTEGER NOT NULL DEFAULT 0, -- 1 = safety number verified via QR
  blocked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, contact_user_id)
);

-- Rate limit log (backup — primary rate limiting in KV)
-- Expire old rows via scheduled worker
CREATE TABLE IF NOT EXISTS rate_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL, -- e.g. "signup:1.2.3.4" or "msg:user-uuid"
  ts INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_rate_log_key ON rate_log(key, ts);
