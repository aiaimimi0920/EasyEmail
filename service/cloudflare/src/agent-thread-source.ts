import type { Env } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { ownedAgentThread } from "./agent-thread-store";
import { agentThreadView } from "./agent-thread-model";
import { agentAccount } from "./agent-account-store";
import { agentServiceRow } from "./agent-service-store";
import { agentSmtpConfig } from "./agent-smtp-store";

export async function agentThreadSource(env: Env, userId: string, id: string) {
  const root = await ownedAgentThread(env, userId, id), inbound = "seed_message_id" in root;
  const accountId = inbound ? root.account_id : root.sender_account_id, serviceId = root.service_id;
  const account = await agentAccount(env, userId, accountId), service = await agentServiceRow(env, userId, serviceId);
  if (!account || account.deleted_at !== null || !service || service.deleted_at !== null) throw new HttpError(409, "agent_followup_source_unavailable");
  const routeHash = await tokenHash(JSON.stringify(["agent-thread-route-v1", userId, id, accountId, serviceId, account.email_address, service.email_address]));
  const lock = await env.DB.prepare("SELECT route_hash FROM agent_thread_sources WHERE user_id=? AND thread_id=?")
    .bind(userId, id).first<{ route_hash: string }>();
  // Old roots are bound lazily only while their original routing evidence still proves the current identity.
  const proved = inbound ? root.account_revision === account.revision && root.service_version === service.version
    : root.from_address !== "" && root.from_address === account.email_address && root.to_address === service.email_address;
  if (lock ? lock.route_hash !== routeHash : !proved) throw new HttpError(409, "agent_followup_route_changed");
  const view = agentThreadView(root), config = await agentSmtpConfig(env, userId, accountId);
  return { root, inbound, account, service, config, routeHash, management: view.management };
}
export function agentThreadSourceFence(userId: string, threadId: string, accountId: string, serviceId: string, routeHash: string) {
  return { sql: `EXISTS(SELECT 1 FROM agent_thread_sources s WHERE s.user_id=? AND s.thread_id=? AND s.account_id=? AND s.service_id=? AND s.route_hash=?
    AND (EXISTS(SELECT 1 FROM agent_threads t WHERE t.user_id=s.user_id AND t.id=s.task_thread_id AND t.sender_account_id=s.account_id AND t.service_id=s.service_id)
      OR EXISTS(SELECT 1 FROM agent_inbound_threads i WHERE i.user_id=s.user_id AND i.id=s.inbound_thread_id AND i.account_id=s.account_id AND i.service_id=s.service_id)))`,
    values: [userId, threadId, accountId, serviceId, routeHash] };
}
export const AGENT_THREAD_UNCERTAIN = `(EXISTS(SELECT 1 FROM agent_outgoing_messages WHERE user_id=? AND thread_id=? AND state IN ('pending','unknown'))
  OR EXISTS(SELECT 1 FROM agent_followups WHERE user_id=? AND thread_id=? AND state IN ('pending','unknown')))`;
export async function agentFollowupContext(env: Env, userId: string, id: string) {
  const source = await agentThreadSource(env, userId, id);
  const uncertain = !!await env.DB.prepare(`SELECT 1 WHERE ${AGENT_THREAD_UNCERTAIN}`).bind(userId, id, userId, id).first();
  return { threadId: id, threadKind: source.inbound ? "inbound" : "task", threadRevision: source.management.revision, threadState: source.management.state,
    senderAccountId: source.account.id, accountRevision: source.account.revision, smtpRevision: source.config?.revision ?? 0,
    serviceId: source.service.id, serviceVersion: source.service.version, from: source.account.email_address, to: source.service.email_address,
    trustLevel: source.service.trust_level, uncertain };
}
