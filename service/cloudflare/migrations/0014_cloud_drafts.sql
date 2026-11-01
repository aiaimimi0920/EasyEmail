CREATE TABLE drafts (
    user_id TEXT NOT NULL REFERENCES users(id),
    id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK(revision > 0),
    state TEXT NOT NULL DEFAULT 'editing' CHECK(state IN ('editing','submitted','deleted')),
    mailbox_id TEXT,
    to_address TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    text_body TEXT NOT NULL DEFAULT '',
    reply_message_id TEXT,
    content_hash TEXT NOT NULL,
    outgoing_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,id)
);
CREATE INDEX drafts_user_state ON drafts(user_id,state);
CREATE INDEX drafts_user_updated ON drafts(user_id,updated_at DESC,id DESC);
