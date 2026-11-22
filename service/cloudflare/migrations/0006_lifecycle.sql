-- Expand only. Keep resource IDs and outgoing FK/idempotency/quota guards intact.
ALTER TABLE mailboxes ADD COLUMN disabled_at INTEGER;
ALTER TABLE mailboxes ADD COLUMN released_at INTEGER;
ALTER TABLE messages ADD COLUMN trashed_at INTEGER;
ALTER TABLE messages ADD COLUMN purged_at INTEGER;
CREATE INDEX messages_trash_page ON messages(user_id, trashed_at, id) WHERE purged_at IS NULL;
