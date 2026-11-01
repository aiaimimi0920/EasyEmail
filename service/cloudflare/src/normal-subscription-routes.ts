import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { normalSubscriptionMessages } from "./normal-subscription-query";
import { normalSubscriptionOperation, normalSubscriptionOperationView, setNormalSubscriptionHidden } from "./normal-subscription-store";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export async function normalSubscriptionRoute(request: Request, env: Env, identity: Identity) {
  requireScope(identity, "mail-accounts:read");
  const url = new URL(request.url), parts = url.pathname.split("/");
  if (!UUID.test(parts[4])) throw new HttpError(404, "not_found");
  if (parts[3] === "normal-subscription-operations") {
    requireScope(identity, "subscriptions:write");
    if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
    if (url.search) throw new HttpError(400, "invalid_filter");
    const row = await normalSubscriptionOperation(env, identity, parts[4]);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: normalSubscriptionOperationView(row) });
  }
  if (request.method === "GET" && parts[6] === "messages") return json(await normalSubscriptionMessages(request, env, identity, parts[4], parts[5]));
  if (parts.length !== 6 || request.method !== "PATCH") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "subscriptions:write");
  if (url.search) throw new HttpError(400, "invalid_filter");
  const key = request.headers.get("idempotency-key") ?? "", body = await readJson(request);
  if (!UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
  if (Object.keys(body).sort().join(",") !== "expectedEpochId,expectedVersion,hidden" || typeof body.expectedEpochId !== "string" || !UUID.test(body.expectedEpochId)
    || typeof body.hidden !== "boolean" || !Number.isSafeInteger(body.expectedVersion)
    || (body.expectedVersion as number) < 0 || (body.expectedVersion as number) >= Number.MAX_SAFE_INTEGER) throw new HttpError(400, "invalid_subscription_request");
  return json(await setNormalSubscriptionHidden(env, identity, key, parts[4], parts[5], body.expectedEpochId, body.expectedVersion as number, body.hidden));
}
