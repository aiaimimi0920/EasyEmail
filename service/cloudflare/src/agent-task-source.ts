import type { Env } from "./contracts";
import { HttpError } from "./http";
import { agentAccount } from "./agent-account-store";
import { agentServiceRow } from "./agent-service-store";
import { agentSmtpConfig, agentSmtpContext } from "./agent-smtp-store";
import { smtpEndpoint } from "./smtp-config-input";
import { agentMailAuthentication, agentEndpointMatches } from "./agent-mail-authentication";
import { assertMailAuthentication } from "./mail-authentication";
import type { AgentTaskInput } from "./agent-task-input";

export async function agentTaskSource(env: Env, userId: string, input: AgentTaskInput, decrypt = false) {
  const account = await agentAccount(env, userId, input.senderAccountId), config = await agentSmtpConfig(env, userId, input.senderAccountId);
  const service = await agentServiceRow(env, userId, input.serviceId);
  if (!account || account.deleted_at !== null || !service || service.deleted_at !== null) throw new HttpError(404, "not_found");
  if (account.revision !== input.accountRevision || config?.revision !== input.smtpRevision || config.account_revision !== account.revision
    || service.version !== input.serviceVersion) throw new HttpError(409, "agent_task_source_changed");
  if (!account.enabled || !config.enabled || !config.credential_cipher || !account.credential_cipher) throw new HttpError(409, "agent_task_sender_unavailable");
  if (service.status !== "active" || service.trust_level === "blocked") throw new HttpError(409, "agent_task_service_unavailable");
  if (service.trust_level === "restricted" && !input.confirmRestricted) throw new HttpError(409, "agent_task_confirmation_required");
  const endpoint = await smtpEndpoint(env, config.endpoint_id);
  if (!agentEndpointMatches(account, endpoint, config.username) || endpoint.hash !== config.endpoint_hash) throw new HttpError(409, "agent_task_source_changed");
  if (!endpoint.recipients.includes("*") && !endpoint.recipients.includes(service.email_address)) throw new HttpError(403, "recipient_not_allowed");
  const credential = decrypt ? await agentMailAuthentication(env, account, config.credential_cipher, agentSmtpContext(account.id, userId), endpoint, config.username) : null;
  if (credential) assertMailAuthentication(config.username, credential.authentication);
  return { account, config, service, endpoint, authentication: credential?.authentication ?? null, authenticationFence: credential?.fence ?? { sql: "1", values: [] } };
}

// Durable tasks survive the creating session/key. Live owner, service and source authorization never do.
export function agentTaskSourceFence(userId: string, input: AgentTaskInput, endpointHash: string) {
  return { sql: `EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')
    AND EXISTS (SELECT 1 FROM agent_accounts a JOIN agent_smtp_configs c ON c.user_id=a.user_id AND c.account_id=a.id
      WHERE a.user_id=? AND a.id=? AND a.revision=? AND a.enabled=1 AND a.deleted_at IS NULL AND a.credential_cipher IS NOT NULL
      AND c.account_revision=a.revision AND c.revision=? AND c.enabled=1 AND c.credential_cipher IS NOT NULL AND c.endpoint_hash=?)
    AND EXISTS (SELECT 1 FROM agent_services WHERE user_id=? AND id=? AND version=? AND deleted_at IS NULL AND status='active'
      AND trust_level<>'blocked' AND (trust_level<>'restricted' OR ?=1))`,
    values: [userId, userId, input.senderAccountId, input.accountRevision, input.smtpRevision, endpointHash,
      userId, input.serviceId, input.serviceVersion, Number(input.confirmRestricted)] };
}
