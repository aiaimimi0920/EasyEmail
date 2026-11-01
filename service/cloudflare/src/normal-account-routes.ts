import type { Env, Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson } from "./http";
import { requireOrigin, requireScope } from "./identity";
import { normalAccountInput, imapEndpoints } from "./normal-account-input";
import { normalAccountView, type NormalAccount } from "./normal-account-model";
import { mutateNormalAccount, normalAccount } from "./normal-account-store";
import { testNormalAccount } from "./normal-account-test";
import { isNormalInboxPath, normalInboxRoute } from "./normal-inbox-routes";
import { isServerFolderPath, serverFolderRoute } from "./normal-server-folder-routes";

export const isNormalAccountPath = (path: string) => isServerFolderPath(path) || isNormalInboxPath(path) || /^\/api\/v1\/normal-accounts(?:\/endpoints|\/[0-9a-f-]{36}(?:\/test)?)?$/.test(path);
export async function normalAccountRoute(request: Request, env: Env, identity: Identity) {
  const path = new URL(request.url).pathname;
  if (isServerFolderPath(path)) return serverFolderRoute(request, env, identity);
  if (isNormalInboxPath(path)) return normalInboxRoute(request, env, identity);
  if (request.method === "GET") {
    requireScope(identity, "mail-accounts:read");
    if (path.endsWith("/endpoints")) return json({ items: imapEndpoints(env) });
    const id = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})$/.exec(path)?.[1];
    if (id) {
      const account = await normalAccount(env, identity.userId, id);
      if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
      return json({ account: normalAccountView(account) });
    }
    if (path !== "/api/v1/normal-accounts") throw new HttpError(405, "method_not_allowed");
    const { limit, cursor } = pageOptions(new URL(request.url));
    const { results } = await env.DB.prepare("SELECT * FROM normal_accounts WHERE user_id=? AND id>? AND deleted_at IS NULL ORDER BY id LIMIT ?")
      .bind(identity.userId, cursor, limit + 1).all<NormalAccount>();
    const items = results.slice(0, limit);
    return json({ items: items.map(normalAccountView), nextCursor: results.length > limit ? items.at(-1)!.id : null });
  }
  if (identity.kind === "session") requireOrigin(request, env);
  const match = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})(\/test)?$/.exec(path);
  if (!match) throw new HttpError(405, "method_not_allowed");
  if (match[2] && request.method === "POST") {
    requireScope(identity, "mail-accounts:sync"); return testNormalAccount(request, env, identity, match[1]);
  }
  if (!match[2] && ["PUT", "DELETE"].includes(request.method)) {
    requireScope(identity, "mail-accounts:write");
    const key = request.headers.get("idempotency-key") ?? "";
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
    const command = normalAccountInput(await readJson(request), request.method === "DELETE");
    const result = await mutateNormalAccount(env, identity, match[1], key, command);
    return json(result, !result.replayed && command.expectedRevision === 0 ? 201 : 200);
  }
  throw new HttpError(405, "method_not_allowed");
}
