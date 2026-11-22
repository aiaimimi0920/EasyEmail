-- Expand only: ordinary tasks retain real account ownership. Old temporary tasks remain untouched.
CREATE TABLE normal_send_jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_revision INTEGER NOT NULL CHECK(account_revision BETWEEN 1 AND 9007199254740991),
  smtp_revision INTEGER NOT NULL CHECK(smtp_revision BETWEEN 1 AND 9007199254740991),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  outgoing_key TEXT NOT NULL,
  outgoing_id TEXT,
  payload_json TEXT,
  attachments_json TEXT CHECK(attachments_json IS NULL OR (json_valid(attachments_json) AND json_type(attachments_json)='array')),
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
  UNIQUE(user_id,draft_id),
  UNIQUE(user_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES normal_accounts(user_id,id)
);
CREATE INDEX normal_send_jobs_due ON normal_send_jobs(state,next_attempt_at,id);
CREATE INDEX normal_send_jobs_account_created ON normal_send_jobs(user_id,account_id,created_at DESC,id DESC);
CREATE INDEX normal_send_jobs_user_created ON normal_send_jobs(user_id,created_at DESC,id DESC);
CREATE INDEX normal_send_jobs_created ON normal_send_jobs(created_at);
CREATE INDEX send_jobs_created ON send_jobs(created_at);
CREATE TABLE normal_send_job_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  job_id TEXT NOT NULL,
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('cancel','retry')),
  applied_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,job_id) REFERENCES normal_send_jobs(user_id,id)
);
CREATE VIEW send_job_usage AS
  SELECT user_id,state,created_at FROM send_jobs
  UNION ALL SELECT user_id,state,created_at FROM normal_send_jobs;
