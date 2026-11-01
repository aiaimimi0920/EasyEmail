CREATE TABLE provider_sync_cursors (
  mailbox_id TEXT PRIMARY KEY REFERENCES mailboxes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  next_page INTEGER,
  cursor TEXT,
  CHECK ((next_page IS NULL AND cursor IS NULL) OR
    (next_page IS NOT NULL AND next_page BETWEEN 2 AND 1000 AND cursor IS NOT NULL AND length(cursor) BETWEEN 1 AND 2048))
);
