-- Per-conversation chat theme (stored per user)
ALTER TABLE conversation_members ADD COLUMN chat_theme TEXT DEFAULT NULL;
