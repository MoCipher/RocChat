-- Add notification mode per conversation member
-- Modes: normal, quiet, focus, emergency, silent, scheduled
ALTER TABLE conversation_members ADD COLUMN notification_mode TEXT DEFAULT 'normal';
