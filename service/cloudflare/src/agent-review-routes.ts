import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { AGENT_ACCOUNT_UUID } from "./agent-account-model";
import { agentInboxContext, agentIncomingMessage, assertAgentInboxCurrent } from "./agent-inbox-access";
import { agentReviewInput } from "./agent-review-input";
import { getAgentReviewOperation, mutateAgentReview } from "./agent-review-store";

export const isAgentReviewPath = (path: string) => /^\/api\/v1\/agent-accounts\/[0-9a-f-]{36}\/(?:messages\/[0-9a-f-]{36}\/review(?:-targets)?|review-operations\/[0-9a-f-]{36})$/.test(path);
export async function agentReviewRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "agent-inbox:read");
  const url = new URL(request.url), parts = url.pathname.split("/"), accountId = parts[4], id = parts[6];
  if (!AGENT_ACCOUNT_UUID.test(accountId) || !AGENT_ACCOUNT_UUID.test(id)) throw new HttpError(404, "not_found");
  if (parts[5] === "review-operations" && request.method === "GET") {
    requireScope(identity, "agent-inbox:review"); if (url.search) throw new HttpError(400, "invalid_filter");
    return json({ operation: await getAgentReviewOperation(env, identity, accountId, id) });
  }
  if (parts[7] === "review-targets" && request.method === "GET") {
    requireScope(identity, "agent-tasks:read");
    const params = url.searchParams, limit = params.get("limit") ?? "20", cursor = params.get("cursor");
    if ([...params.keys()].some(key => !["limit", "cursor"].includes(key) || params.getAll(key).length !== 1)
      || !/^\d{1,2}$/.test(limit) || Number(limit) < 1 || Number(limit) > 20 || cursor !== null && !AGENT_ACCOUNT_UUID.test(cursor)) throw new HttpError(400, "invalid_filter");
    const context = await agentInboxContext(env, identity, accountId); await agentIncomingMessage(env, context, id);
    const rows = (await env.DB.prepare(`SELECT t.id,o.subject,o.from_address AS sender,o.to_address AS recipient,o.state,o.submitted_at AS submittedAt
      FROM agent_threads t JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id
      WHERE t.user_id=? AND t.sender_account_id=? AND t.id>? AND o.submitted_at IS NOT NULL AND o.from_address=? ORDER BY t.id LIMIT ?`)
      .bind(identity.userId, accountId, cursor ?? "", context.account.email_address, Number(limit) + 1).all()).results;
    await assertAgentInboxCurrent(env, identity, context); await agentIncomingMessage(env, context, id);
    return json({ items: rows.slice(0, Number(limit)), nextCursor: rows.length > Number(limit) ? rows[Number(limit) - 1].id : null });
  }
  if (parts[7] === "review" && request.method === "PUT") {
    requireWriteScope(request, env, identity, "agent-inbox:review"); if (url.search) throw new HttpError(400, "invalid_filter");
    const input = agentReviewInput(await readJson(request)), key = request.headers.get("idempotency-key") ?? "";
    if (input.threadId) requireScope(identity, "agent-tasks:read");
    if (!AGENT_ACCOUNT_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    return json(await mutateAgentReview(env, identity, accountId, id, key, input));
  }
  throw new HttpError(405, "method_not_allowed");
}
