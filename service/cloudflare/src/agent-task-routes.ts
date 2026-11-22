import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_SERVICE_UUID } from "./agent-service-model";
import { agentTaskInput } from "./agent-task-input";
import { enqueueAgentTask } from "./agent-task-enqueue";
import { agentTaskByKey, agentTaskView, AGENT_TASK_SELECT, ownedAgentTask, type AgentTaskRow } from "./agent-task-store";
import { cancelAgentTask } from "./agent-task-lifecycle";

export const isAgentTaskPath = (path: string) => /^\/api\/v1\/agent-tasks(?:\/[0-9a-f-]{36}(?:\/cancel)?)?$/.test(path);
export async function agentTaskRoute(request: Request, env: Env, identity: Identity) {
  const url = new URL(request.url), parts = url.pathname.split("/").slice(4), id = parts[0];
  requireScope(identity, "agent-tasks:read");
  const names = [...url.searchParams.keys()];
  if (new Set(names).size !== names.length || names.some(name => !["requestKey", "limit", "cursor"].includes(name))) throw new HttpError(400, "invalid_filter");
  if (id && (!AGENT_SERVICE_UUID.test(id) || url.search) || request.method !== "GET" && url.search) throw new HttpError(400, "invalid_filter");
  if (!id && request.method === "GET") {
    const key = url.searchParams.get("requestKey");
    if (key !== null) {
      if (!AGENT_SERVICE_UUID.test(key) || names.length !== 1) throw new HttpError(400, "invalid_agent_task_request");
      const row = await agentTaskByKey(env, identity.userId, key); if (!row) throw new HttpError(404, "not_found");
      return json({ task: agentTaskView(row) });
    }
    const { limit, cursor } = pageOptions(url);
    if (cursor) await ownedAgentTask(env, identity.userId, cursor);
    const { results } = await env.DB.prepare(`${AGENT_TASK_SELECT} WHERE t.user_id=? ${cursor ? "AND t.id>?" : ""} ORDER BY t.id LIMIT ?`)
      .bind(identity.userId, ...(cursor ? [cursor] : []), limit + 1).all<AgentTaskRow>();
    return json({ items: results.slice(0, limit).map(row => agentTaskView(row, false)), nextCursor: results.length > limit ? results[limit - 1].id : null });
  }
  if (id && parts.length === 1 && request.method === "GET") return json({ task: agentTaskView(await ownedAgentTask(env, identity.userId, id)) });
  if (!id && request.method === "POST") {
    requireWriteScope(request, env, identity, "agent-tasks:send");
    const key = request.headers.get("idempotency-key") ?? ""; if (!AGENT_SERVICE_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const result = await enqueueAgentTask(env, identity, key, agentTaskInput(await readJson(request))); return json(result, result.replayed ? 200 : 201);
  }
  if (id && parts[1] === "cancel" && request.method === "POST") {
    requireWriteScope(request, env, identity, "agent-tasks:send");
    const body = await readJson(request);
    if (Object.keys(body).some(key => key !== "expectedRevision") || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1
      || (body.expectedRevision as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_agent_task_request");
    return json({ task: agentTaskView(await cancelAgentTask(env, identity, id, body.expectedRevision as number)) });
  }
  throw new HttpError(405, "method_not_allowed");
}
