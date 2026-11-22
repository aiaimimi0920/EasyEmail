import { requireAdministrator } from "./admin-access";
import { adminProbe } from "./admin-probe";
import { saveAdminProvider } from "./admin-save";
import { adminOverview, listAdminAudit, listAdminProviders } from "./admin-store";
import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { retentionAdmin } from "./retention-admin";
import { accountAdmin, isAccountAdminPath } from "./account-admin";

export function isAdminPath(path: string): boolean {
  return isAccountAdminPath(path) || /^\/api\/v1\/admin\/(?:overview|audit|retention(?:\/(?:preview|run))?|providers(?:\/[a-z][a-z0-9-]{0,47}(?:\/probe)?)?)$/.test(path);
}

export async function adminRoute(request: Request, env: Env, identity: Identity): Promise<Response> {
  await requireAdministrator(request, env, identity);
  const path = new URL(request.url).pathname;
  if (isAccountAdminPath(path)) return accountAdmin(request, env, identity);
  if (path === "/api/v1/admin/retention" || path.startsWith("/api/v1/admin/retention/")) return retentionAdmin(request, env, identity);
  if (request.method === "GET") {
    if (path.endsWith("/providers")) return listAdminProviders(env);
    if (path.endsWith("/overview")) return adminOverview(env);
    if (path.endsWith("/audit")) return listAdminAudit(request, env);
  }
  const match = /^\/api\/v1\/admin\/providers\/([a-z][a-z0-9-]{0,47})(\/probe)?$/.exec(path);
  if (match && !match[2] && request.method === "PUT") return saveAdminProvider(request, env, identity, match[1]);
  if (match?.[2] && request.method === "POST") return adminProbe(request, env, identity, match[1]);
  throw new HttpError(405, "method_not_allowed");
}
