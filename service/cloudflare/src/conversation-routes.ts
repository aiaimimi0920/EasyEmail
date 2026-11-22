import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope } from "./identity";
import { listConversations, conversationMembers } from "./conversation-query";
import { unifiedConversations } from "./unified-conversations";

export const isConversationPath = (path: string) => path === "/api/v1/conversations" || /^\/api\/v1\/conversations\/[0-9a-f-]{36}\/messages$/.test(path);
export async function conversationRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "messages:read");
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  const path = new URL(request.url).pathname, anchor = path.split("/")[4];
  if (anchor && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(anchor)) throw new HttpError(404, "not_found");
  return json(new URL(request.url).searchParams.has("sources") ? await unifiedConversations(request, env, identity, anchor)
    : anchor ? await conversationMembers(request, env, identity, anchor) : await listConversations(request, env, identity));
}
