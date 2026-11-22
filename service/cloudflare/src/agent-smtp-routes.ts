import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { smtpConfigInput, smtpEndpoints } from "./smtp-config-input";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentAccount } from "./agent-account-store";
import { agentSmtpView } from "./agent-smtp-model";
import { agentSmtpConfig, agentSmtpOperation, completedAgentSmtpOperation, saveAgentSmtp } from "./agent-smtp-store";

export const isAgentSmtpPath = (path: string) => /^\/api\/v1\/agent-accounts\/(?:smtp-endpoints|[0-9a-f-]{36}\/smtp)$/.test(path)
  || /^\/api\/v1\/agent-smtp-operations\/[0-9a-f-]{36}$/.test(path);
export async function agentSmtpRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), path = url.pathname;
  requireScope(identity, "agent-accounts:read");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (path.endsWith("/smtp-endpoints")) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    return json({ items: smtpEndpoints(env)
      .map(({ id, label, hostname, port, security, authentication }) => ({ id, label, hostname, port, security: security ?? "tls", authentication: authentication ?? "password" })) });
  }
  if (path.startsWith("/api/v1/agent-smtp-operations/")) {
    requireScope(identity, "agent-accounts:write");
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const key = path.split("/").at(-1)!;
    if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(404, "not_found");
    const row = await agentSmtpOperation(env, identity.userId, key);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: completedAgentSmtpOperation(row) });
  }
  const id = path.split("/").at(-2)!;
  if (!AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (request.method === "GET") {
    const account = await agentAccount(env, identity.userId, id);
    if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
    return json({ smtp: agentSmtpView(await agentSmtpConfig(env, identity.userId, id), account) });
  }
  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "agent-accounts:write");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  const body = await readJson(request); let input: ReturnType<typeof smtpConfigInput>;
  try { input = smtpConfigInput(body); } catch { throw new HttpError(400, "invalid_agent_smtp_request"); }
  return json(await saveAgentSmtp(env, identity, id, key, input));
}
