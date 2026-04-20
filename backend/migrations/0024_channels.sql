-- Channels & Communities
-- Channels: one-to-many broadcast (admins post, subscribers read)
-- Communities: umbrella grouping channels + discussion groups

-- Expand conversation type to include channel and community
-- SQLite doesn't support ALTER CHECK, but D1 allows new values if we drop the constraint
-- We add a separate channels table for channel-specific metadata

CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  topic TEXT DEFAULT '',
  is_public INTEGER NOT NULL DEFAULT 1,  -- 1 = discoverable via search
  subscriber_count INTEGER NOT NULL DEFAULT 0,
  community_id TEXT,  -- parent community (NULL if standalone)
  tags TEXT DEFAULT '',  -- comma-separated tags for discovery
  avatar_url TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_channels_public ON channels(is_public) WHERE is_public = 1;
CREATE INDEX IF NOT EXISTS idx_channels_community ON channels(community_id) WHERE community_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channels_tags ON channels(tags);

-- Communities group multiple channels
CREATE TABLE IF NOT EXISTS communities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  avatar_url TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  is_public INTEGER NOT NULL DEFAULT 1,
  member_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_communities_public ON communities(is_public) WHERE is_public = 1;

-- Community membership
CREATE TABLE IF NOT EXISTS community_members (
  community_id TEXT NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  joined_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (community_id, user_id)
);
