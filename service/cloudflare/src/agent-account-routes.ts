import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { imapEndpoints } from "./normal-account-input";
import { agentAccountCommand } from "./agent-account-input";
import { AGENT_ACCOUNT_UUID, agentAccountView, type AgentAccount } from "./agent-account-model";
import { agentAccount, agentAccountOperation, completedAgentAccountOperation, mutateAgentAccount } from "./agent-account-store";
import { testAgentAccount } from "./agent-account-test";
import { agentAccountTable } from "./agent-account-authentication";

export const isAgentAccountPath = (path: string) => /^\/api\/v1\/agent-accounts(?:\/endpoints|\/[0-9a-f-]{36}(?:\/test)?)?$/.test(path)
  || /^\/api\/v1\/agent-account-operations\/[0-9a-f-]{36}$/.test(path);
export async function agentAccountRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), path = url.pathname;
  requireScope(identity, "agent-accounts:read");
  if (path.startsWith("/api/v1/agent-account-operations/")) {
    requireScope(identity, "agent-accounts:write");
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    const key = path.split("/").at(-1)!;
    if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(404, "not_found");
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await agentAccountOperation(env, identity.userId, key);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: completedAgentAccountOperation(row) });
  }
  const match = /^\/api\/v1\/agent-accounts\/([0-9a-f-]{36})(\/test)?$/.exec(path);
  if (match && !AGENT_ACCOUNT_UUID.test(match[1])) throw new HttpError(404, "not_found");
  if (request.method === "GET") {
    if (path.endsWith("/endpoints")) {
      if (url.search) throw new HttpError(400, "invalid_filter");
      return json({ items: imapEndpoints(env) });
    }
    if (match && !match[2]) {
      if (url.search) throw new HttpError(400, "invalid_filter");
      const row = await agentAccount(env, identity.userId, match[1]);
      if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
      return json({ account: agentAccountView(row) });
    }
    if (path !== "/api/v1/agent-accounts") throw new HttpError(405, "method_not_allowed");
    if ([...url.searchParams.keys()].some(key => !["limit", "cursor"].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new HttpError(400, "invalid_filter");
    const { limit, cursor } = pageOptions(url);
    if (cursor && !AGENT_ACCOUNT_UUID.test(cursor)) throw new HttpError(400, "invalid_filter");
    const { results } = await env.DB.prepare(`SELECT * FROM ${await agentAccountTable(env)} WHERE user_id=? AND id>? AND deleted_at IS NULL ORDER BY id LIMIT ?`)
      .bind(identity.userId, cursor, limit + 1).all<AgentAccount>();
    const items = results.slice(0, limit);
    return json({ items: items.map(agentAccountView), nextCursor: results.length > limit ? items.at(-1)!.id : null });
  }
  if (!match || (match[2] ? request.method !== "POST" : !["PUT", "DELETE"].includes(request.method))) throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, match[2] ? "agent-accounts:sync" : "agent-accounts:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (match[2]) return testAgentAccount(request, env, identity, match[1]);
  const key = request.headers.get("idempotency-key") ?? "";
  if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  const command = agentAccountCommand(await readJson(request), request.method === "DELETE");
  const result = await mutateAgentAccount(env, identity, match[1], key, command);
  return json(result, !result.replayed && command.expectedRevision === 0 ? 201 : 200);
}
