-- Add avatar_url to users table for profile photos
ALTER TABLE users ADD COLUMN avatar_url TEXT DEFAULT NULL;
