import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { agentAccountCredentialFence } from "./agent-account-store";
import { assertAgentThreadCredential } from "./agent-thread-store";
import { AGENT_THREAD_EFFECTIVE_STATE } from "./agent-thread-model";
import { agentThreadSource, agentThreadSourceFence, AGENT_THREAD_UNCERTAIN } from "./agent-thread-source";
import { agentTaskSource, agentTaskSourceFence } from "./agent-task-source";
import { agentFollowupHash, type AgentFollowupInput } from "./agent-followup-input";
import { agentFollowupByKey, agentFollowupView } from "./agent-followup-store";
import { agentFollowupAnchor } from "./agent-followup-anchor";
import { smtpMime } from "./smtp-mime";

export async function enqueueAgentFollowup(env: Env, identity: Identity, threadId: string, key: string, input: AgentFollowupInput) {
  const hash = await agentFollowupHash(threadId, input);
  const replay = async (row: NonNullable<Awaited<ReturnType<typeof agentFollowupByKey>>>) => {
    await assertAgentThreadCredential(env, identity);
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { followup: agentFollowupView(row), replayed: true };
  };
  const previous = await agentFollowupByKey(env, identity.userId, key); if (previous) return replay(previous);
  const route = await agentThreadSource(env, identity.userId, threadId);
  if (input.senderAccountId !== route.account.id || input.serviceId !== route.service.id) throw new HttpError(409, "agent_followup_route_changed");
  const source = await agentTaskSource(env, identity.userId, input), live = agentTaskSourceFence(identity.userId, input, source.endpoint.hash);
  if (source.account.email_address !== route.account.email_address || source.service.email_address !== route.service.email_address)
    throw new HttpError(409, "agent_followup_route_changed");
  const anchor = await agentFollowupAnchor(env, identity, threadId, input, source.account.email_address, source.service.email_address);
  const id = crypto.randomUUID(), now = unixNow();
  smtpMime({ from: source.account.email_address, to: source.service.email_address, subject: input.subject, text: input.text, id, createdAt: now, threading: anchor });
  const management = route.inbound ? `EXISTS(SELECT 1 FROM agent_inbound_threads WHERE user_id=? AND id=? AND revision=? AND state IN ('open','needs_attention'))`
    : `EXISTS(SELECT 1 FROM agent_threads t JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id
      LEFT JOIN agent_thread_management w ON w.user_id=t.user_id AND w.thread_id=t.id
      WHERE t.user_id=? AND t.id=? AND COALESCE(w.revision,0)=? AND ${AGENT_THREAD_EFFECTIVE_STATE} IN ('open','needs_attention'))`;
  const guard = `${live.sql} AND ${agentAccountCredentialFence(identity)} AND ${management} AND ${anchor.sql}
    AND EXISTS(SELECT 1 FROM agent_accounts WHERE user_id=? AND id=? AND email_address=?)
    AND EXISTS(SELECT 1 FROM agent_services WHERE user_id=? AND id=? AND email_address=?)
    AND (?=1 OR NOT ${AGENT_THREAD_UNCERTAIN})
    AND (SELECT COUNT(*) FROM agent_queued_sends WHERE user_id=?)<100
    AND (SELECT COUNT(*) FROM agent_followups WHERE user_id=?)<10000
    AND (SELECT COUNT(*) FROM agent_followups WHERE user_id=? AND thread_id=?)<1000`;
  const values = [...live.values, identity.credentialId, identity.userId, identity.userId, threadId, input.expectedThreadRevision, ...anchor.values,
    identity.userId, source.account.id, source.account.email_address, identity.userId, source.service.id, source.service.email_address,
    Number(input.confirmUncertain), identity.userId, threadId, identity.userId, threadId, identity.userId, identity.userId, identity.userId, threadId];
  const root = agentThreadSourceFence(identity.userId, threadId, source.account.id, source.service.id, route.routeHash);
  let failed = false;
  try {
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_thread_sources(user_id,thread_id,task_thread_id,inbound_thread_id,account_id,service_id,route_hash,created_at)
        SELECT ?,?,?,?,?,?,?,? WHERE ${guard} ON CONFLICT(user_id,thread_id) DO NOTHING`)
        .bind(identity.userId, threadId, route.inbound ? null : threadId, route.inbound ? threadId : null, source.account.id, source.service.id, route.routeHash, now, ...values),
      env.DB.prepare(`INSERT INTO agent_followups(id,user_id,thread_id,account_id,service_id,route_hash,account_revision,smtp_revision,service_version,endpoint_hash,
        confirm_restricted,confirm_uncertain,thread_revision,request_key,request_hash,reply_type,reply_id,in_reply_to,references_json,rfc_message_id,
        from_address,to_address,subject,text_body,recipient_count,state,revision,next_attempt_at,deadline_at,created_at,updated_at)
        SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,'queued',1,?,?,?,? WHERE ${guard} AND ${root.sql}
        ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(id, identity.userId, threadId, source.account.id, source.service.id, route.routeHash, input.accountRevision, input.smtpRevision, input.serviceVersion,
          source.endpoint.hash, Number(input.confirmRestricted), Number(input.confirmUncertain), input.expectedThreadRevision, key, hash,
          input.replyToType, input.replyToId, anchor.inReplyTo, JSON.stringify(anchor.references), `<${id}@easyemail.invalid>`, source.account.email_address,
          source.service.email_address, input.subject, input.text, now, now + 86400, now, now, ...values, ...root.values),
    ]);
  } catch { failed = true; }
  const result = await agentFollowupByKey(env, identity.userId, key);
  await assertAgentThreadCredential(env, identity);
  if (failed && result?.id === id) throw new HttpError(503, "agent_followup_storage_failed");
  if (result) return result.id === id ? { followup: agentFollowupView(result), replayed: false } : replay(result);
  if (failed) throw new HttpError(503, "agent_followup_storage_failed");
  throw new HttpError(409, "agent_followup_changed_confirmation_or_limit");
}
