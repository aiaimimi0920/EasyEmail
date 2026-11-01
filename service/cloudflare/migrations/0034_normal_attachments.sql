ALTER TABLE drafts ADD COLUMN normal_attachments_json TEXT CHECK (
  normal_attachments_json IS NULL OR (normal_account_id IS NOT NULL AND json_valid(normal_attachments_json) AND json_type(normal_attachments_json)='array')
);
ALTER TABLE normal_outgoing_messages ADD COLUMN attachments_json TEXT CHECK (
  attachments_json IS NULL OR (json_valid(attachments_json) AND json_type(attachments_json)='array')
);
