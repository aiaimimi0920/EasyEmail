import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { AGENT_THREAD_COLUMNS, AGENT_THREAD_EFFECTIVE_STATE, agentThreadInput, agentThreadPage, agentThreadView, type AgentThreadRow } from "./agent-thread-model";
import { assertAgentThreadCredential, getAgentThreadOperation, mutateAgentThread, ownedAgentThread } from "./agent-thread-store";
import { AGENT_INBOUND_THREAD_SELECT, type AgentInboundThreadRow } from "./agent-inbound-model";

export const isAgentThreadPath = (path: string) => /^\/api\/v1\/(?:agent-threads(?:\/[0-9a-f-]{36}(?:\/state)?)?|agent-thread-operations\/[0-9a-f-]{36})$/.test(path);
export async function agentThreadRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "agent-tasks:read");
  const url = new URL(request.url), parts = url.pathname.split("/"), id = parts[4];
  if (id && !AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (parts[3] === "agent-thread-operations") {
    requireScope(identity, "agent-threads:write"); if (url.search) throw new HttpError(400, "invalid_filter");
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    return json({ operation: await getAgentThreadOperation(env, identity, id) });
  }
  if (!id && request.method === "GET") {
    const { state, limit, cursor } = agentThreadPage(url);
    if (cursor) await ownedAgentThread(env, identity.userId, cursor);
    const [tasks, inbound] = await Promise.all([env.DB.prepare(`${AGENT_THREAD_COLUMNS} WHERE t.user_id=? AND t.id>?
      ${state ? `AND ${AGENT_THREAD_EFFECTIVE_STATE}=?` : ""} ORDER BY t.id LIMIT ?`)
      .bind(identity.userId, cursor ?? "", ...(state ? [state] : []), limit + 1).all<AgentThreadRow>(),
    env.DB.prepare(`${AGENT_INBOUND_THREAD_SELECT} WHERE i.user_id=? AND i.id>? ${state ? "AND i.state=?" : ""} ORDER BY i.id LIMIT ?`)
      .bind(identity.userId, cursor ?? "", ...(state ? [state] : []), limit + 1).all<AgentInboundThreadRow>()]);
    const rows = [...tasks.results, ...inbound.results].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    await assertAgentThreadCredential(env, identity);
    return json({ items: rows.slice(0, limit).map(row => agentThreadView(row, false)), nextCursor: rows.length > limit ? `${rows[limit - 1].id}.${state || "all"}` : null });
  }
  if (url.search) throw new HttpError(400, "invalid_filter");
  if (id && !parts[5] && request.method === "GET") {
    const row = await ownedAgentThread(env, identity.userId, id); await assertAgentThreadCredential(env, identity); return json({ thread: agentThreadView(row) });
  }
  if (id && parts[5] === "state" && request.method === "PUT") {
    requireWriteScope(request, env, identity, "agent-threads:write");
    const key = request.headers.get("idempotency-key") ?? ""; if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    return json(await mutateAgentThread(env, identity, id, key, agentThreadInput(await readJson(request))));
  }
  throw new HttpError(405, "method_not_allowed");
}
