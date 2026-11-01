import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentInboundInput } from "./agent-inbound-model";
import { createAgentInbound, getAgentInboundOperation } from "./agent-inbound-store";

export const isAgentInboundPath = (path: string) => /^\/api\/v1\/agent-accounts\/[0-9a-f-]{36}\/(?:messages\/[0-9a-f-]{36}\/inbound-thread|inbound-thread-operations\/[0-9a-f-]{36})$/.test(path);
export async function agentInboundRoute(request: Request, env: Env, identity: Identity) {
  for (const scope of ["agent-inbox:read", "agent-inbox:review", "agent-tasks:read", "agent-services:read", "agent-threads:write"]) requireScope(identity, scope);
  const url = new URL(request.url), parts = url.pathname.split("/"), accountId = parts[4], id = parts[6];
  if (!AGENT_ACCOUNT_UUID.test(accountId) || !AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (parts[5] === "inbound-thread-operations" && request.method === "GET") return json({ operation: await getAgentInboundOperation(env, identity, accountId, id) });
  if (parts[7] === "inbound-thread" && request.method === "PUT") {
    requireWriteScope(request, env, identity, "agent-threads:write");
    const key = request.headers.get("idempotency-key") ?? "";
    if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const result = await createAgentInbound(env, identity, accountId, id, key, agentInboundInput(await readJson(request)));
    return json(result, result.replayed ? 200 : 201);
  }
  throw new HttpError(405, "method_not_allowed");
}
