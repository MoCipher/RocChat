-- Add mute and archive support to conversation members
ALTER TABLE conversation_members ADD COLUMN muted_at INTEGER;
ALTER TABLE conversation_members ADD COLUMN archived_at INTEGER;
