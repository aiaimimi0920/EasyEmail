import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { getAgentInboxRequest, requestAgentInbox } from "./agent-inbox-requests";
import { getAgentIncoming, listAgentIncoming } from "./agent-inbox-queries";
import { downloadAgentIncoming } from "./agent-inbox-download";

export const isAgentInboxPath = (path: string) => /^\/api\/v1\/agent-accounts\/[0-9a-f-]{36}\/(?:sync|sync-requests\/[0-9a-f-]{36}|messages(?:\/[0-9a-f-]{36}(?:\/raw|\/attachments\/\d{1,3})?)?)$/.test(path);
export async function agentInboxRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "agent-inbox:read");
  const url = new URL(request.url), [, accountId, resource, id, download] = /^\/api\/v1\/agent-accounts\/([0-9a-f-]{36})\/([^/]+)(?:\/([^/]+))?(?:\/(.+))?$/.exec(url.pathname)!;
  if (!AGENT_ACCOUNT_UUID.test(accountId) || id && !AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if ((resource !== "messages" || id) && url.search) throw new HttpError(400, "invalid_filter");
  if (resource === "sync" && request.method === "POST") {
    requireWriteScope(request, env, identity, "agent-accounts:sync");
    const body = await readJson(request), key = request.headers.get("idempotency-key") ?? "";
    if (Object.keys(body).some(key => key !== "expectedRevision") || !Number.isSafeInteger(body.expectedRevision)
      || (body.expectedRevision as number) < 1 || (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_agent_inbox_request");
    if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    return json({ operation: await requestAgentInbox(env, identity, accountId, body.expectedRevision as number, key) });
  }
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  if (download) return downloadAgentIncoming(env, identity, accountId, id, download === "raw" ? null : Number(download.slice(12)));
  if (resource === "sync-requests") return json({ operation: await getAgentInboxRequest(env, identity, accountId, id) });
  if (resource === "messages") return json(id ? await getAgentIncoming(env, identity, accountId, id) : await listAgentIncoming(request, env, identity, accountId));
  throw new HttpError(405, "method_not_allowed");
}
