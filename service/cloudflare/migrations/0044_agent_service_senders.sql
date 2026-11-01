-- Defaults are private directory metadata, not permission to send or to execute a reply.
CREATE TABLE agent_service_senders (
  user_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  PRIMARY KEY(user_id,service_id),
  FOREIGN KEY(user_id,service_id) REFERENCES agent_services(user_id,id),
  FOREIGN KEY(user_id,account_id) REFERENCES agent_accounts(user_id,id)
);
CREATE INDEX agent_service_senders_account ON agent_service_senders(user_id,account_id);

-- Old runtimes also tombstone services. They must not leave a live default behind.
CREATE TRIGGER agent_service_sender_deleted AFTER UPDATE OF deleted_at ON agent_services
WHEN NEW.deleted_at IS NOT NULL
BEGIN
  DELETE FROM agent_service_senders WHERE user_id=NEW.user_id AND service_id=NEW.id;
END;
