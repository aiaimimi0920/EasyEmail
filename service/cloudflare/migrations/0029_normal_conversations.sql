-- Additive derived index: source objects, receipt identity and cursors remain unchanged.
ALTER TABLE normal_inbox_messages ADD COLUMN thread_key TEXT;
ALTER TABLE normal_inbox_messages ADD COLUMN thread_basis TEXT;
ALTER TABLE normal_inbox_messages ADD COLUMN thread_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE normal_inbox_messages ADD COLUMN thread_limited INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX normal_accounts_thread_owner ON normal_accounts(user_id,id);
CREATE UNIQUE INDEX normal_messages_thread_owner ON normal_inbox_messages(account_id,epoch_id,id);
CREATE INDEX normal_messages_thread_groups ON normal_inbox_messages(account_id,epoch_id,thread_key);
CREATE TABLE normal_thread_links (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  token TEXT NOT NULL,
  group_id TEXT NOT NULL,
  PRIMARY KEY(user_id,account_id,epoch_id,message_id,token),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id),
  FOREIGN KEY(account_id,epoch_id,message_id) REFERENCES normal_inbox_messages(account_id,epoch_id,id)
);
CREATE INDEX normal_thread_links_token ON normal_thread_links(user_id,account_id,epoch_id,token,group_id);
CREATE INDEX normal_thread_links_group ON normal_thread_links(user_id,account_id,epoch_id,group_id,message_id);
