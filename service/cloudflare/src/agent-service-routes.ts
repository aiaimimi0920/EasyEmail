import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { agentServiceCommand } from "./agent-service-input";
import { AGENT_SERVICE_UUID, agentServiceView } from "./agent-service-model";
import { listAgentServices } from "./agent-service-query";
import { agentServiceOperation, agentServiceRow, completedAgentServiceOperation, mutateAgentService } from "./agent-service-store";

export const isAgentServicePath = (path: string) => /^\/api\/v1\/agent-services(?:\/[0-9a-f-]{36})?$/.test(path)
  || /^\/api\/v1\/agent-service-operations\/[0-9a-f-]{36}$/.test(path);

export async function agentServiceRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), operation = url.pathname.startsWith("/api/v1/agent-service-operations/");
  const list = url.pathname === "/api/v1/agent-services", id = list ? null : url.pathname.split("/").at(-1)!;
  if (id && !AGENT_SERVICE_UUID.test(id)) throw new HttpError(404, "not_found");
  requireScope(identity, "agent-services:read");
  if (operation) {
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    requireScope(identity, "agent-services:write");
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await agentServiceOperation(env, identity.userId, id!);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: completedAgentServiceOperation(row) });
  }
  if (request.method === "GET") {
    if (list) return json(await listAgentServices(url, env, identity));
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await agentServiceRow(env, identity.userId, id!);
    if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
    return json({ service: agentServiceView(row) });
  }
  if (list ? request.method !== "POST" : !["PATCH", "DELETE"].includes(request.method)) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "agent-services:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!AGENT_SERVICE_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  const result = await mutateAgentService(env, identity, key, await agentServiceCommand(request, id));
  return json(result, list && !result.replayed ? 201 : 200);
}
