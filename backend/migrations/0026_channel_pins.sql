-- Add pinned post support to channels
ALTER TABLE channels ADD COLUMN pinned_post_id TEXT DEFAULT NULL;
