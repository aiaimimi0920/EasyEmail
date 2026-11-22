-- Platform metadata only: this migration does not delete or mutate upstream mail.
ALTER TABLE mailboxes ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE mailboxes ADD COLUMN note TEXT NOT NULL DEFAULT '';
ALTER TABLE mailboxes ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1));
ALTER TABLE mailboxes ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1));

ALTER TABLE messages ADD COLUMN is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1));
ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0, 1));
ALTER TABLE messages ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));

CREATE INDEX messages_user_timeline ON messages(user_id, COALESCE(received_at, observed_at) DESC, id DESC);
CREATE INDEX messages_user_folder_timeline ON messages(user_id, archived, COALESCE(received_at, observed_at) DESC, id DESC);
