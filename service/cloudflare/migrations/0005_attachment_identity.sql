-- Additive content verification metadata. Never rewrite old fingerprints or local message IDs.
ALTER TABLE messages ADD COLUMN attachment_version TEXT;
ALTER TABLE messages ADD COLUMN attachments_truncated INTEGER NOT NULL DEFAULT 0 CHECK (attachments_truncated IN (0, 1));
