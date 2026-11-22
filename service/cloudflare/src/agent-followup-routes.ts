import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { assertAgentThreadCredential, ownedAgentThread } from "./agent-thread-store";
import { agentFollowupContext } from "./agent-thread-source";
import { agentFollowupInput } from "./agent-followup-input";
import { enqueueAgentFollowup } from "./agent-followup-enqueue";
import { AGENT_FOLLOWUP_SELECT, agentFollowupByKey, agentFollowupView, ownedAgentFollowup, type AgentFollowupRow } from "./agent-followup-store";
import { cancelAgentFollowup } from "./agent-followup-lifecycle";

export const isAgentFollowupPath = (path: string) => /^\/api\/v1\/(?:agent-followups(?:\/[0-9a-f-]{36}(?:\/cancel)?)?|agent-threads\/[0-9a-f-]{36}\/(?:followups|followup-context))$/.test(path);
export async function agentFollowupRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "agent-tasks:read");
  const url = new URL(request.url), parts = url.pathname.split("/"), id = parts[4], thread = parts[3] === "agent-threads";
  if (id && !AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (request.method === "GET") {
    if (thread && parts[5] === "followup-context") {
      if (url.search) throw new HttpError(400, "invalid_filter");
      const context = await agentFollowupContext(env, identity.userId, id); await assertAgentThreadCredential(env, identity); return json({ context });
    }
    if (thread) {
      const names = [...url.searchParams.keys()];
      if (new Set(names).size !== names.length || names.some(key => !["limit", "cursor"].includes(key))) throw new HttpError(400, "invalid_filter");
      if (!url.searchParams.has("limit")) url.searchParams.set("limit", "20");
      const { limit, cursor } = pageOptions(url); if (limit > 20) throw new HttpError(400, "invalid_filter");
      await ownedAgentThread(env, identity.userId, id);
      if (cursor && (await ownedAgentFollowup(env, identity.userId, cursor)).thread_id !== id) throw new HttpError(400, "invalid_cursor");
      const { results } = await env.DB.prepare(`${AGENT_FOLLOWUP_SELECT} WHERE f.user_id=? AND f.thread_id=? AND f.id>? ORDER BY f.id LIMIT ?`)
        .bind(identity.userId, id, cursor, limit + 1).all<AgentFollowupRow>();
      await assertAgentThreadCredential(env, identity);
      return json({ items: results.slice(0, limit).map(row => agentFollowupView(row, false)), nextCursor: results.length > limit ? results[limit - 1].id : null });
    }
    let row: AgentFollowupRow | null;
    if (id) {
      if (url.search || parts[5]) throw new HttpError(400, "invalid_filter"); row = await ownedAgentFollowup(env, identity.userId, id);
    } else {
      const key = url.searchParams.get("requestKey");
      if (!key || !AGENT_ACCOUNT_UUID.test(key) || [...url.searchParams.keys()].join(",") !== "requestKey") throw new HttpError(400, "invalid_filter");
      row = await agentFollowupByKey(env, identity.userId, key); if (!row) throw new HttpError(404, "not_found");
    }
    await assertAgentThreadCredential(env, identity); return json({ followup: agentFollowupView(row) });
  }
  if (url.search) throw new HttpError(400, "invalid_filter");
  requireWriteScope(request, env, identity, "agent-threads:send");
  if (thread && parts[5] === "followups" && request.method === "POST") {
    const key = request.headers.get("idempotency-key") ?? ""; if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const result = await enqueueAgentFollowup(env, identity, id, key, agentFollowupInput(await readJson(request))); return json(result, result.replayed ? 200 : 201);
  }
  if (!thread && id && parts[5] === "cancel" && request.method === "POST") {
    const body = await readJson(request);
    if (Object.keys(body).join(",") !== "expectedRevision" || !Number.isSafeInteger(body.expectedRevision)
      || Number(body.expectedRevision) < 1 || Number(body.expectedRevision) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_agent_followup_request");
    return json({ followup: agentFollowupView(await cancelAgentFollowup(env, identity, id, body.expectedRevision as number)) });
  }
  throw new HttpError(405, "method_not_allowed");
}
