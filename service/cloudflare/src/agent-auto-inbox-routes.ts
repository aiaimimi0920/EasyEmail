import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { autoInboxCommand, autoInboxOperationView } from "./agent-auto-inbox-model";
import { autoInboxConfig, autoInboxOperation, writeAutoInbox } from "./agent-auto-inbox-config";

export const isAutoInboxPath = (path: string) => /^\/api\/v1\/agent-accounts\/[0-9a-f-]{36}\/auto-inbox$/.test(path)
  || /^\/api\/v1\/agent-inbox-automation-operations\/[0-9a-f-]{36}$/.test(path);
export async function autoInboxRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url); requireScope(identity, "agent-accounts:read");
  if (url.search) throw new HttpError(400, "invalid_filter");
  const operation = url.pathname.includes("/agent-inbox-automation-operations/"), id = url.pathname.split("/").at(operation ? -1 : -2)!;
  if (!AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (operation) {
    requireScope(identity, "agent-inbox:automate"); if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const row = await autoInboxOperation(env, identity, id); if (!row) throw new HttpError(404, "not_found");
    return json({ operation: autoInboxOperationView(row) });
  }
  if (request.method === "GET") return json({ config: await autoInboxConfig(env, identity.userId, id) });
  if (request.method !== "PUT") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "agent-inbox:automate");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  return json({ operation: await writeAutoInbox(env, identity, id, key, autoInboxCommand(await readJson(request))) });
}
