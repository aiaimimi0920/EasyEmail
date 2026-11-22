import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { agentAccountCredentialFence } from "./agent-account-store";
import { agentTaskHash, type AgentTaskInput } from "./agent-task-input";
import { agentTaskSource, agentTaskSourceFence } from "./agent-task-source";
import { agentTaskByKey, agentTaskView } from "./agent-task-store";
import { smtpMime } from "./smtp-mime";

export async function enqueueAgentTask(env: Env, identity: Identity, key: string, input: AgentTaskInput) {
  const hash = await agentTaskHash(input), previous = await agentTaskByKey(env, identity.userId, key);
  const replay = (row: NonNullable<typeof previous>) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { task: agentTaskView(row), replayed: true };
  };
  if (previous) return replay(previous);
  const source = await agentTaskSource(env, identity.userId, input), live = agentTaskSourceFence(identity.userId, input, source.endpoint.hash);
  const id = crypto.randomUUID(), outgoingId = crypto.randomUUID(), now = unixNow(), messageId = `<${outgoingId}@easyemail.invalid>`;
  smtpMime({ from: source.account.email_address, to: source.service.email_address, subject: input.subject, text: input.text, id: outgoingId, createdAt: now });
  const fence = "EXISTS (SELECT 1 FROM agent_threads WHERE id=? AND user_id=?)";
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_threads(id,user_id,service_id,service_version,sender_account_id,account_revision,smtp_revision,endpoint_hash,confirm_restricted,request_key,request_hash,correlation_key,state,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,? WHERE ${live.sql} AND ${agentAccountCredentialFence(identity)}
        AND (SELECT COUNT(*) FROM agent_threads WHERE user_id=?)<10000 AND (SELECT COUNT(*) FROM agent_send_jobs WHERE user_id=? AND state='queued')<100
        ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(id, identity.userId, input.serviceId, input.serviceVersion, input.senderAccountId, input.accountRevision, input.smtpRevision,
          source.endpoint.hash, Number(input.confirmRestricted), key, hash, `agent-${id}`, now, now, ...live.values, identity.credentialId, identity.userId, identity.userId, identity.userId),
      env.DB.prepare(`INSERT INTO agent_outgoing_messages(id,user_id,thread_id,rfc_message_id,from_address,to_address,subject,text_body,recipient_count,state,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,1,'queued',?,? WHERE ${fence}`)
        .bind(outgoingId, identity.userId, id, messageId, source.account.email_address, source.service.email_address, input.subject, input.text, now, now, id, identity.userId),
      env.DB.prepare(`INSERT INTO agent_thread_messages(user_id,thread_id,outgoing_id,direction,semantic_role,parsed_status,created_at)
        SELECT ?,?,?,'outgoing','task_request','queued',? WHERE ${fence}`).bind(identity.userId, id, outgoingId, now, id, identity.userId),
      env.DB.prepare(`INSERT INTO agent_send_jobs(id,user_id,thread_id,outgoing_id,state,revision,next_attempt_at,deadline_at,created_at,updated_at)
        SELECT ?,?,?,?,'queued',1,?,?,?,? WHERE ${fence}`)
        .bind(crypto.randomUUID(), identity.userId, id, outgoingId, now, now + 86400, now, now, id, identity.userId),
    ]);
  } catch { throw new HttpError(503, "agent_task_storage_failed"); }
  const row = await agentTaskByKey(env, identity.userId, key);
  if (!row) {
    const active = await env.DB.prepare(`SELECT 1 WHERE ${agentAccountCredentialFence(identity)}`).bind(identity.credentialId, identity.userId).first();
    if (!active) throw new HttpError(401, "unauthorized");
    throw new HttpError(409, "agent_task_changed_or_limit");
  }
  return row.id === id ? { task: agentTaskView(row), replayed: false } : replay(row);
}
