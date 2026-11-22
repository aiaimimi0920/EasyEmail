-- Expand only. Legacy task, review, inbox rows and their FK targets are unchanged.
CREATE TABLE agent_thread_sources (
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  task_thread_id TEXT,
  inbound_thread_id TEXT,
  account_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  route_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,thread_id),
  UNIQUE(user_id,thread_id,account_id,service_id,route_hash),
  CHECK((task_thread_id IS NOT NULL)+(inbound_thread_id IS NOT NULL)=1),
  CHECK(thread_id=COALESCE(task_thread_id,inbound_thread_id)),
  FOREIGN KEY(user_id,task_thread_id) REFERENCES agent_threads(user_id,id),
  FOREIGN KEY(user_id,inbound_thread_id) REFERENCES agent_inbound_threads(user_id,id)
);
CREATE TRIGGER agent_thread_source_owner BEFORE INSERT ON agent_thread_sources
WHEN NOT EXISTS(SELECT 1 FROM agent_threads WHERE user_id=NEW.user_id AND id=NEW.task_thread_id
    AND sender_account_id=NEW.account_id AND service_id=NEW.service_id)
  AND NOT EXISTS(SELECT 1 FROM agent_inbound_threads WHERE user_id=NEW.user_id AND id=NEW.inbound_thread_id
    AND account_id=NEW.account_id AND service_id=NEW.service_id)
BEGIN SELECT RAISE(ABORT,'agent_thread_source_mismatch'); END;
CREATE TRIGGER agent_thread_source_immutable BEFORE UPDATE ON agent_thread_sources
BEGIN SELECT RAISE(ABORT,'agent_thread_source_immutable'); END;

CREATE TABLE agent_followups (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  route_hash TEXT NOT NULL,
  account_revision INTEGER NOT NULL,
  smtp_revision INTEGER NOT NULL,
  service_version INTEGER NOT NULL,
  endpoint_hash TEXT NOT NULL,
  confirm_restricted INTEGER NOT NULL CHECK(confirm_restricted IN (0,1)),
  confirm_uncertain INTEGER NOT NULL CHECK(confirm_uncertain IN (0,1)),
  thread_revision INTEGER NOT NULL CHECK(thread_revision>=0),
  request_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  reply_type TEXT NOT NULL CHECK(reply_type IN ('task','followup','incoming')),
  reply_id TEXT NOT NULL,
  in_reply_to TEXT NOT NULL,
  references_json TEXT NOT NULL,
  rfc_message_id TEXT NOT NULL UNIQUE,
  from_address TEXT NOT NULL,
  to_address TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  recipient_count INTEGER NOT NULL CHECK(recipient_count=1),
  state TEXT NOT NULL CHECK(state IN ('queued','pending','accepted','rejected','unknown','cancelled','not_sent')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 9007199254740991),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  deadline_at INTEGER NOT NULL,
  dispatch_token TEXT,
  submitted_at INTEGER,
  error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  content_purged_at INTEGER,
  UNIQUE(user_id,request_key),
  FOREIGN KEY(user_id,thread_id,account_id,service_id,route_hash)
    REFERENCES agent_thread_sources(user_id,thread_id,account_id,service_id,route_hash)
);
CREATE INDEX agent_followups_thread ON agent_followups(user_id,thread_id,id);
CREATE INDEX agent_followups_due ON agent_followups(state,next_attempt_at,id);
CREATE INDEX agent_followups_pending ON agent_followups(state,submitted_at);
CREATE INDEX agent_followups_reply_id ON agent_followups(user_id,account_id,service_id,lower(rfc_message_id)) WHERE submitted_at IS NOT NULL;
CREATE INDEX agent_outgoing_reply_id ON agent_outgoing_messages(user_id,lower(rfc_message_id)) WHERE submitted_at IS NOT NULL;
CREATE VIEW agent_queued_sends AS
  SELECT user_id,id FROM agent_send_jobs WHERE state='queued'
  UNION ALL SELECT user_id,id FROM agent_followups WHERE state='queued';
-- Triggers also protect old task writers that do not know about follow-ups.
CREATE TRIGGER agent_task_mixed_queue_capacity BEFORE INSERT ON agent_send_jobs
WHEN NEW.state='queued' AND (SELECT COUNT(*) FROM agent_queued_sends WHERE user_id=NEW.user_id)>=100
BEGIN SELECT RAISE(ABORT,'agent_queue_limit'); END;
CREATE TRIGGER agent_followup_queue_capacity BEFORE INSERT ON agent_followups
WHEN NEW.state='queued' AND (SELECT COUNT(*) FROM agent_queued_sends WHERE user_id=NEW.user_id)>=100
BEGIN SELECT RAISE(ABORT,'agent_queue_limit'); END;
CREATE TRIGGER agent_followup_history_capacity BEFORE INSERT ON agent_followups
WHEN NOT EXISTS(SELECT 1 FROM agent_followups WHERE user_id=NEW.user_id AND request_key=NEW.request_key)
  AND ((SELECT COUNT(*) FROM agent_followups WHERE user_id=NEW.user_id)>=10000
    OR (SELECT COUNT(*) FROM agent_followups WHERE user_id=NEW.user_id AND thread_id=NEW.thread_id)>=1000)
BEGIN SELECT RAISE(ABORT,'agent_followup_limit'); END;

-- Same name and columns: old quota readers include new actual submissions.
DROP VIEW send_recipient_charges;
CREATE VIEW send_recipient_charges AS
  SELECT user_id,recipient_count,created_at FROM outgoing_messages
  UNION ALL SELECT user_id,recipient_count,created_at FROM normal_outgoing_messages
  UNION ALL SELECT user_id,recipient_count,submitted_at AS created_at FROM agent_outgoing_messages WHERE submitted_at IS NOT NULL
  UNION ALL SELECT user_id,recipient_count,submitted_at AS created_at FROM agent_followups WHERE submitted_at IS NOT NULL;
CREATE VIEW agent_reply_candidates AS
  SELECT t.user_id,t.sender_account_id AS account_id,t.service_id,'task' AS kind,t.id AS thread_id,
    o.rfc_message_id,o.from_address,o.to_address,o.submitted_at FROM agent_threads t
    JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id WHERE o.submitted_at IS NOT NULL
  UNION ALL SELECT f.user_id,f.account_id,f.service_id,CASE WHEN s.task_thread_id IS NOT NULL THEN 'task' ELSE 'inbound' END,
    f.thread_id,f.rfc_message_id,f.from_address,f.to_address,f.submitted_at FROM agent_followups f
    JOIN agent_thread_sources s ON s.user_id=f.user_id AND s.thread_id=f.thread_id WHERE f.submitted_at IS NOT NULL;
