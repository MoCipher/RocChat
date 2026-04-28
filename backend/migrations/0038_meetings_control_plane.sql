-- RocChat Meetings control-plane (SFU-first roadmap)

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  host_user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled', -- scheduled|live|ended
  media_mode TEXT NOT NULL DEFAULT 'sfu',   -- sfu|mesh
  starts_at INTEGER,
  ends_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meeting_participants (
  meeting_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'participant', -- host|moderator|participant|viewer
  state TEXT NOT NULL DEFAULT 'active',     -- active|lobby|removed
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (meeting_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_meetings_host_created
  ON meetings(host_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meetings_conversation_created
  ON meetings(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_meeting_participants_user
  ON meeting_participants(user_id, joined_at DESC);
