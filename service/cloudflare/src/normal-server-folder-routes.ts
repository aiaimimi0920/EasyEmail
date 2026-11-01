import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { normalRevision, imapEndpoint } from "./normal-account-input";
import { normalContext } from "./normal-account-store";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { listImapFolders } from "./normal-imap-client";
import { rateLimit } from "./rate-limits";
import { serverFolderAccount, readServerFolders, claimServerFolders, assertServerFolderClaim, publishServerFolders, releaseServerFolders } from "./normal-server-folder-store";
import { isFolderInboxPath, folderInboxRoute } from "./normal-folder-inbox-routes";

export const isServerFolderPath = (path: string) => isFolderInboxPath(path) || /^\/api\/v1\/normal-accounts\/[0-9a-f-]{36}\/server-folders(?:\/discover)?$/.test(path);
export async function serverFolderRoute(request: Request, env: Env, identity: Identity) {
  if (isFolderInboxPath(new URL(request.url).pathname)) return folderInboxRoute(request, env, identity);
  const [, id, discover] = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/server-folders(\/discover)?$/.exec(new URL(request.url).pathname)!;
  if (!discover && request.method === "GET") return json({ catalog: await readServerFolders(env, identity, id) });
  if (!discover || request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireWriteScope(request, env, identity, "mail-accounts:sync");
  const body = await readJson(request), revision = normalRevision(body);
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_normal_account_request");
  const account = await serverFolderAccount(env, identity, id);
  if (account.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const endpoint = await imapEndpoint(env, account.endpoint_id);
  if (endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "normal-folder-discovery", identity.userId, 10); await rateLimit(env, "normal-folder-discovery-global", "platform", 60);
  const token = crypto.randomUUID();
  try {
    await claimServerFolders(env, identity, account, token);
    const credential = await normalMailAuthentication(env, account, account.credential_cipher, normalContext(id, identity.userId), endpoint, account.username);
    await assertServerFolderClaim(env, identity, account, token, credential.fence);
    const result = await listImapFolders(endpoint, account.username, credential.authentication);
    await publishServerFolders(env, identity, account, token, result.folders, credential.fence);
    return json({ catalog: await readServerFolders(env, identity, id) });
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "normal_folder_storage_unknown");
  } finally { await releaseServerFolders(env, id, token).catch(() => {}); }
}
