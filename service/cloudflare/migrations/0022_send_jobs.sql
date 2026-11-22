CREATE TABLE send_jobs (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    outgoing_key TEXT NOT NULL,
    outgoing_id TEXT,
    payload_json TEXT,
    attachments_json TEXT,
    draft_id TEXT,
    draft_revision INTEGER,
    scheduled_at INTEGER,
    due_at INTEGER NOT NULL,
    deadline_at INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('queued','preparing','submitted','cancelled','failed')),
    revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
    manual_retries INTEGER NOT NULL DEFAULT 0 CHECK(manual_retries BETWEEN 0 AND 3),
    claim_token TEXT,
    lease_until INTEGER,
    error_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    content_purged_at INTEGER,
    UNIQUE(user_id,request_key),
    UNIQUE(user_id,outgoing_key),
    UNIQUE(user_id,draft_id)
);
CREATE INDEX send_jobs_due ON send_jobs(state,next_attempt_at,id);
CREATE INDEX send_jobs_user_created ON send_jobs(user_id,created_at DESC,id DESC);
CREATE INDEX send_jobs_mailbox_active ON send_jobs(mailbox_id,state);
CREATE TABLE send_job_operations (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    job_id TEXT NOT NULL REFERENCES send_jobs(id),
    request_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('cancel','retry')),
    applied_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(user_id,request_key)
);
