-- Expand-only derived metadata and private platform preferences, not remote subscription state.
CREATE TABLE message_subscriptions (
  user_id TEXT NOT NULL,
  mailbox_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subscription_key TEXT,
  list_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  unsubscribe_methods TEXT NOT NULL CHECK(json_valid(unsubscribe_methods)),
  limited INTEGER NOT NULL CHECK(limited IN (0,1)),
  PRIMARY KEY(user_id,mailbox_id,message_id),
  FOREIGN KEY(user_id,mailbox_id,message_id) REFERENCES messages(user_id,mailbox_id,id)
);
CREATE INDEX subscriptions_group ON message_subscriptions(user_id,mailbox_id,subscription_key,message_id);
CREATE TABLE subscription_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  subscription_key TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
  version INTEGER NOT NULL CHECK(version>0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,mailbox_id,subscription_key)
);
CREATE TABLE subscription_operations (
  user_id TEXT NOT NULL REFERENCES users(id),
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
  subscription_key TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
  version INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key)
);
