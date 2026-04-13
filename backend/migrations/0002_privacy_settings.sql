-- RocChat D1 Schema — Privacy Settings Migration
-- Adds privacy columns to users table

ALTER TABLE users ADD COLUMN show_read_receipts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN show_typing_indicator INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN show_online_to TEXT NOT NULL DEFAULT 'everyone'; -- everyone, contacts, nobody
ALTER TABLE users ADD COLUMN who_can_add TEXT NOT NULL DEFAULT 'everyone'; -- everyone, nobody
ALTER TABLE users ADD COLUMN default_disappear_timer INTEGER; -- seconds, NULL = off
