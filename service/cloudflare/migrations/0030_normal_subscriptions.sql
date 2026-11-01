-- Derived MIME evidence and private preferences only. No upstream subscription action.
CREATE TABLE normal_message_subscriptions (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  subscription_key TEXT,
  list_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  sender_address TEXT NOT NULL,
  unsubscribe_methods TEXT NOT NULL CHECK(json_valid(unsubscribe_methods)),
  limited INTEGER NOT NULL CHECK(limited IN (0,1)),
  evidence_present INTEGER NOT NULL CHECK(evidence_present IN (0,1)),
  PRIMARY KEY(user_id,account_id,epoch_id,message_id),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id),
  FOREIGN KEY(account_id,epoch_id,message_id) REFERENCES normal_inbox_messages(account_id,epoch_id,id)
);
CREATE INDEX normal_subscriptions_group ON normal_message_subscriptions(user_id,account_id,epoch_id,subscription_key,message_id);
CREATE TABLE normal_subscription_preferences (
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  epoch_id TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
  version INTEGER NOT NULL CHECK(version>0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,account_id,epoch_id,subscription_key),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE TABLE normal_subscription_operations (
  user_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  id TEXT NOT NULL UNIQUE,
  request_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  epoch_id TEXT NOT NULL,
  subscription_key TEXT NOT NULL,
  hidden INTEGER NOT NULL CHECK(hidden IN (0,1)),
  version INTEGER,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY(user_id,request_key),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE INDEX normal_subscription_operations_account ON normal_subscription_operations(user_id,account_id);
