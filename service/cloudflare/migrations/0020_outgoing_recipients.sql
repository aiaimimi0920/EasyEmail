-- Expand only. Old rows retain the exact single-address payload, hash and one-recipient cost.
ALTER TABLE outgoing_messages ADD COLUMN recipients_json TEXT CHECK (recipients_json IS NULL OR json_valid(recipients_json));
ALTER TABLE outgoing_messages ADD COLUMN recipient_count INTEGER NOT NULL DEFAULT 1 CHECK (recipient_count BETWEEN 1 AND 50);
ALTER TABLE drafts ADD COLUMN recipients_json TEXT CHECK (recipients_json IS NULL OR json_valid(recipients_json));
