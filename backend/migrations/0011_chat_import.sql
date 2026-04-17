-- Chat import: track which messages were imported from external apps
ALTER TABLE messages ADD COLUMN imported_from TEXT DEFAULT NULL;
-- Donor badges: track donation tier per user
ALTER TABLE users ADD COLUMN donor_tier TEXT DEFAULT NULL;
