import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { normalRevision } from "./normal-account-input";
import { getFolderSyncRequest, listFolderSyncRequests, requestFolderSync } from "./normal-folder-sync-requests";
import { getNormalMessage, listNormalMessages } from "./normal-message-queries";
import { downloadNormalMessage } from "./normal-message-download";
import { organizeNormalMessages, getNormalOrganization } from "./normal-organization";
import { getNormalTaxonomy } from "./normal-message-taxonomy";
import { normalReplyPreview } from "./normal-reply";
import { getRemoteFlagOperation, normalRemoteFlags } from "./normal-remote-flags";
import { getRemoteMutationOperation, normalRemoteMutations } from "./normal-remote-mutations";

export const isFolderInboxPath = (path: string) => /^\/api\/v1\/normal-accounts\/[0-9a-f-]{36}\/server-folders\/[0-9a-f]{64}\/(?:sync|sync-requests(?:\/[a-zA-Z0-9_-]{16,128})?|(?:organization-operations|remote-flag-operations|remote-mutation-operations)\/[a-zA-Z0-9_-]{16,128}|messages\/organize|messages(?:\/[0-9a-f-]{36}(?:\/raw|\/attachments\/\d{1,3}|\/labels|\/folder|\/reply|\/remote-flags|\/remote-mutations)?)?)$/.test(path);
export async function folderInboxRoute(request: Request, env: Env, identity: Identity) {
  const [, accountId, folderId, resource] = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/server-folders\/([0-9a-f]{64})\/(.+)$/.exec(new URL(request.url).pathname)!;
  const mutation = /^messages\/([0-9a-f-]{36})\/remote-mutations$/.exec(resource);
  if (mutation) return normalRemoteMutations(request, env, identity, accountId, mutation[1], folderId);
  if (resource === "messages/organize" && request.method === "POST") return organizeNormalMessages(request, env, identity, accountId, folderId);
  const flags = /^messages\/([0-9a-f-]{36})\/remote-flags$/.exec(resource);
  if (flags) return normalRemoteFlags(request, env, identity, accountId, flags[1], folderId);
  if (resource === "sync" && request.method === "POST") {
    requireWriteScope(request, env, identity, "mail-accounts:sync");
    const body = await readJson(request), revision = normalRevision(body), key = request.headers.get("idempotency-key") ?? "";
    if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_normal_account_request");
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
    return json({ request: await requestFolderSync(env, identity, accountId, folderId, revision, key) });
  }
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  if (resource.startsWith("remote-mutation-operations/")) return getRemoteMutationOperation(env, identity, accountId, resource.slice(27), folderId);
  if (resource.startsWith("remote-flag-operations/")) return getRemoteFlagOperation(env, identity, accountId, resource.slice(23), folderId);
  const reply = /^messages\/([0-9a-f-]{36})\/reply$/.exec(resource);
  if (reply) return json(await normalReplyPreview(request, env, identity, accountId, reply[1], folderId));
  if (resource.startsWith("organization-operations/")) return getNormalOrganization(env, identity, accountId, resource.slice(24), folderId);
  const taxonomy = /^messages\/([0-9a-f-]{36})\/(labels|folder)$/.exec(resource);
  if (taxonomy) return getNormalTaxonomy(request, env, identity, accountId, taxonomy[1], taxonomy[2] as "labels" | "folder", folderId);
  if (resource.startsWith("sync-requests")) {
    requireScope(identity, "mail-accounts:sync");
    return json(resource === "sync-requests" ? await listFolderSyncRequests(env, identity, accountId, folderId)
      : { request: await getFolderSyncRequest(env, identity, accountId, folderId, resource.slice(14)) });
  }
  if (resource === "messages") return json(await listNormalMessages(request, env, identity, accountId, folderId));
  const message = /^messages\/([0-9a-f-]{36})(?:\/(raw|attachments\/(\d{1,3})))?$/.exec(resource);
  if (!message) throw new HttpError(404, "not_found");
  if (!message[2]) return json(await getNormalMessage(env, identity, accountId, message[1], folderId));
  return downloadNormalMessage(env, identity, accountId, message[1], message[2] === "raw" ? null : Number(message[3]), folderId);
}
