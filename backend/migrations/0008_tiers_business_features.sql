-- Add account tier and business features support
-- account_tier: 'free', 'premium', 'business' (premium is free for all, business requires subscription)
ALTER TABLE users ADD COLUMN account_tier TEXT NOT NULL DEFAULT 'premium';

-- Organization table for business accounts
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  logo_url TEXT,
  accent_color TEXT DEFAULT '#D4AF37',
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Organization members
CREATE TABLE IF NOT EXISTS organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'moderator', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (org_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- Scheduled messages
CREATE TABLE IF NOT EXISTS scheduled_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  encrypted TEXT NOT NULL,
  scheduled_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  sent INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_scheduled_msgs ON scheduled_messages(scheduled_at, sent);

-- Chat folders
CREATE TABLE IF NOT EXISTS chat_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '📁',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS chat_folder_items (
  folder_id TEXT NOT NULL REFERENCES chat_folders(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, conversation_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_folders_user ON chat_folders(user_id);

-- Message retention policies (business)
CREATE TABLE IF NOT EXISTS retention_policies (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  max_age_days INTEGER NOT NULL DEFAULT 365,
  auto_delete INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (org_id)
);

-- Add nickname column to existing contacts table (already has user_id, contact_user_id, verified, blocked)
ALTER TABLE contacts ADD COLUMN nickname TEXT;
