import type { Env, Identity } from "./contracts";
import { HttpError, json } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { LABEL_UUID } from "./label-input";
import { getMessageLabels, labelRoute } from "./label-routes";
import { organizationInput, organizationScopes } from "./organization-input";
import { organizationRow, organizationView, runOrganization } from "./organization-store";
import { folderRoute, isFolderPath } from "./folder-routes";

export const isOrganizationPath = (path: string) => isFolderPath(path) || /^\/api\/v1\/labels(?:\/[0-9a-f-]{36})?$/.test(path)
  || path === "/api/v1/messages/organize" || /^\/api\/v1\/organization\/[0-9a-f-]{36}$/.test(path)
  || /^\/api\/v1\/mailboxes\/[0-9a-f-]{36}\/messages\/[0-9a-f-]{36}\/labels$/.test(path);

export async function organizationRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  const url = new URL(request.url), path = url.pathname;
  if (isFolderPath(path)) return folderRoute(request, env, identity);
  if (path.startsWith("/api/v1/labels")) return labelRoute(request, env, identity);
  if (url.search) throw new HttpError(400, "invalid_filter");
  const message = /^\/api\/v1\/mailboxes\/([0-9a-f-]{36})\/messages\/([0-9a-f-]{36})\/labels$/.exec(path);
  if (message && request.method === "GET") return getMessageLabels(request, env, identity, message[1], message[2]);
  if (path === "/api/v1/messages/organize" && request.method === "POST") {
    requireWriteScope(request, env, identity, "messages:write");
    const key = request.headers.get("idempotency-key");
    if (!key || !LABEL_UUID.test(key)) throw new HttpError(400, "invalid_idempotency_key");
    const input = await organizationInput(request);
    for (const scope of organizationScopes(input)) requireScope(identity, scope);
    return json(await runOrganization(env, identity, key, input));
  }
  if (path.startsWith("/api/v1/organization/") && request.method === "GET") {
    requireScope(identity, "messages:write");
    const key = path.slice("/api/v1/organization/".length);
    if (!LABEL_UUID.test(key)) throw new HttpError(404, "not_found");
    const row = await organizationRow(env, identity.userId, key);
    if (!row) throw new HttpError(404, "not_found");
    return json({ operation: organizationView(row, identity) });
  }
  throw new HttpError(405, "method_not_allowed");
}
