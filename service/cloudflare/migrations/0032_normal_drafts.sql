ALTER TABLE drafts ADD COLUMN normal_account_id TEXT REFERENCES normal_accounts(id);
ALTER TABLE drafts ADD COLUMN normal_account_revision INTEGER CHECK (
  (normal_account_id IS NULL AND normal_account_revision IS NULL) OR
  (normal_account_id IS NOT NULL AND normal_account_revision IS NOT NULL AND normal_account_revision BETWEEN 1 AND 9007199254740990
    AND mailbox_id IS NULL AND reply_message_id IS NULL AND attachments_json IS NULL)
);
CREATE INDEX drafts_normal_account_updated ON drafts(user_id,normal_account_id,updated_at DESC,id DESC);
