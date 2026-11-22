// Identity, organization, timestamps and fingerprints remain for deduplication and outgoing foreign keys.
export const MESSAGE_CONTENT_RESET = `sender = '', recipient = '', subject = '', text_body = '', html_body = '',
  attachments = '[]', rfc_message_id = NULL, attachments_truncated = 0,
  thread_key=NULL,thread_basis=NULL,thread_limited=0,thread_version=2`;
