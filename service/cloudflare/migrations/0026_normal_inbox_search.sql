CREATE TABLE normal_inbox_search (
  message_id TEXT PRIMARY KEY REFERENCES normal_inbox_messages(id),
  content_sha256 TEXT NOT NULL,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  html_body TEXT NOT NULL
);
