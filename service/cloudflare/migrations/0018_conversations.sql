-- Derived, mailbox-scoped conversation index. Existing messages and fingerprints are not rewritten.
ALTER TABLE messages ADD COLUMN thread_key TEXT;
ALTER TABLE messages ADD COLUMN thread_basis TEXT;
ALTER TABLE messages ADD COLUMN thread_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN thread_limited INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX messages_thread_owner ON messages(user_id,mailbox_id,id);
CREATE INDEX messages_thread_groups ON messages(user_id,mailbox_id,thread_key) WHERE purged_at IS NULL;
CREATE TABLE message_thread_links (
  user_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  token TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY(user_id,mailbox_id,message_id,token),
  FOREIGN KEY(user_id,mailbox_id,message_id) REFERENCES messages(user_id,mailbox_id,id)
);
CREATE INDEX thread_links_token ON message_thread_links(user_id,mailbox_id,token,group_id);
CREATE INDEX thread_links_group ON message_thread_links(user_id,mailbox_id,group_id,message_id);
