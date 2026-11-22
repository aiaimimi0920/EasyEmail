ALTER TABLE mailbox_creations ADD COLUMN acknowledged_at INTEGER CHECK (acknowledged_at IS NULL OR acknowledged_at >= 0);
CREATE INDEX mailbox_creations_owner_history ON mailbox_creations(user_id, created_at DESC, mailbox_id DESC);
