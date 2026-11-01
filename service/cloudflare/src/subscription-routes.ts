import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { listSubscriptions, subscriptionMessages } from "./subscription-query";
import { setSubscriptionHidden, subscriptionOperation, subscriptionOperationView } from "./subscription-store";
import { unifiedSubscriptions } from "./unified-subscriptions";
import { normalSubscriptionRoute } from "./normal-subscription-routes";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isSubscriptionPath = (path: string) => path === "/api/v1/subscriptions"
  || /^\/api\/v1\/subscriptions\/[0-9a-f-]{36}\/[a-f0-9]{64}(?:\/messages)?$/.test(path)
  || /^\/api\/v1\/subscription-operations\/[0-9a-f-]{36}$/.test(path)
  || /^\/api\/v1\/normal-subscriptions\/[0-9a-f-]{36}\/[a-f0-9]{64}(?:\/messages)?$/.test(path)
  || /^\/api\/v1\/normal-subscription-operations\/[0-9a-f-]{36}$/.test(path);
export async function subscriptionRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "messages:read"); requireScope(identity, "subscriptions:read");
  const url = new URL(request.url), parts = url.pathname.split("/"), list = parts.length === 4;
  if (parts[3].startsWith("normal-subscription")) return normalSubscriptionRoute(request, env, identity);
  if (parts[3] === "subscription-operations") {
    requireScope(identity, "subscriptions:write");
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    if (!UUID.test(parts[4]) || url.search) throw new HttpError(400, "invalid_filter");
    const row = await subscriptionOperation(env, identity.userId, parts[4]);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: subscriptionOperationView(row) });
  }
  if (!list && !UUID.test(parts[4])) throw new HttpError(404, "not_found");
  if (request.method === "GET") {
    if (list) return json(await (url.searchParams.has("sources") ? unifiedSubscriptions(request, env, identity) : listSubscriptions(request, env, identity)));
    if (parts[6] === "messages") return json(await subscriptionMessages(request, env, identity, parts[4], parts[5]));
  }
  if (list || parts.length !== 6 || request.method !== "PATCH") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "subscriptions:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  const key = request.headers.get("idempotency-key") ?? "", body = await readJson(request);
  if (!UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  if (Object.keys(body).sort().join(",") !== "expectedVersion,hidden" || typeof body.hidden !== "boolean" || !Number.isSafeInteger(body.expectedVersion)
    || (body.expectedVersion as number) < 0 || (body.expectedVersion as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_subscription_request");
  return json(await setSubscriptionHidden(env, identity, key, parts[4], parts[5], body.expectedVersion as number, body.hidden));
}
