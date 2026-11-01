ALTER TABLE drafts ADD COLUMN normal_reply_message_id TEXT CHECK (normal_reply_message_id IS NULL OR normal_account_id IS NOT NULL);
ALTER TABLE normal_outgoing_messages ADD COLUMN reply_message_id TEXT;
ALTER TABLE normal_outgoing_messages ADD COLUMN reply_threading TEXT CHECK (
  (reply_message_id IS NULL AND reply_threading IS NULL) OR
  (reply_message_id IS NOT NULL AND reply_threading IS NOT NULL AND reply_threading IN ('submitted','unavailable'))
);
