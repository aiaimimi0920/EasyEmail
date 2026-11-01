import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { normalRevision } from "./normal-account-input";
import { getNormalSyncRequest, listNormalSyncRequests, requestNormalSync } from "./normal-sync-requests";
import { getNormalMessage, listNormalMessages } from "./normal-message-queries";
import { downloadNormalMessage } from "./normal-message-download";
import { normalExtractions } from "./normal-extraction";
import { organizeNormalMessages, getNormalOrganization } from "./normal-organization";
import { getNormalTaxonomy } from "./normal-message-taxonomy";
import { normalReplyPreview } from "./normal-reply";
import { getRemoteFlagOperation, normalRemoteFlags } from "./normal-remote-flags";
import { getRemoteMutationOperation, normalRemoteMutations } from "./normal-remote-mutations";

export const isNormalInboxPath = (path: string) => /^\/api\/v1\/normal-accounts\/[0-9a-f-]{36}\/(?:sync|sync-requests(?:\/[a-zA-Z0-9_-]{16,128})?|(?:organization-operations|remote-flag-operations|remote-mutation-operations)\/[a-zA-Z0-9_-]{16,128}|extractions|messages\/organize|messages(?:\/[0-9a-f-]{36}(?:\/raw|\/attachments\/\d{1,3}|\/labels|\/folder|\/reply|\/remote-flags|\/remote-mutations)?)?)$/.test(path);
export async function normalInboxRoute(request: Request, env: Env, identity: Identity) {
  const path = new URL(request.url).pathname;
  const match = /^\/api\/v1\/normal-accounts\/([0-9a-f-]{36})\/(.+)$/.exec(path)!;
  const [, accountId, resource] = match;
  const mutation = /^messages\/([0-9a-f-]{36})\/remote-mutations$/.exec(resource);
  if (mutation) return normalRemoteMutations(request, env, identity, accountId, mutation[1]);
  if (resource.startsWith("remote-mutation-operations/") && request.method === "GET") return getRemoteMutationOperation(env, identity, accountId, resource.slice(27));
  const remoteFlags = /^messages\/([0-9a-f-]{36})\/remote-flags$/.exec(resource);
  if (remoteFlags) return normalRemoteFlags(request, env, identity, accountId, remoteFlags[1]);
  if (resource.startsWith("remote-flag-operations/") && request.method === "GET") return getRemoteFlagOperation(env, identity, accountId, resource.slice(23));
  if (resource === "messages/organize" && request.method === "POST") return organizeNormalMessages(request, env, identity, accountId);
  if (resource === "sync" && request.method === "POST") {
    requireWriteScope(request, env, identity, "mail-accounts:sync");
    const body = await readJson(request), revision = normalRevision(body), key = request.headers.get("idempotency-key") ?? "";
    if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_normal_account_request");
    if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
    return json({ request: await requestNormalSync(env, identity, accountId, revision, key) });
  }
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  const reply = /^messages\/([0-9a-f-]{36})\/reply$/.exec(resource);
  if (reply) return json(await normalReplyPreview(request, env, identity, accountId, reply[1]));
  const taxonomy = /^messages\/([0-9a-f-]{36})\/(labels|folder)$/.exec(resource);
  if (taxonomy) return getNormalTaxonomy(request, env, identity, accountId, taxonomy[1], taxonomy[2] as "labels" | "folder");
  if (resource.startsWith("organization-operations/")) return getNormalOrganization(env, identity, accountId, resource.slice(24));
  if (resource === "extractions") return normalExtractions(request, env, identity, accountId);
  if (resource === "sync-requests" || resource.startsWith("sync-requests/")) {
    requireScope(identity, "mail-accounts:sync");
    return json(resource === "sync-requests" ? await listNormalSyncRequests(env, identity, accountId)
      : { request: await getNormalSyncRequest(env, identity, accountId, resource.slice(14)) });
  }
  if (resource === "messages") return json(await listNormalMessages(request, env, identity, accountId));
  const message = /^messages\/([0-9a-f-]{36})(?:\/(raw|attachments\/(\d{1,3})))?$/.exec(resource);
  if (!message) throw new HttpError(404, "not_found");
  if (!message[2]) return json(await getNormalMessage(env, identity, accountId, message[1]));
  return downloadNormalMessage(env, identity, accountId, message[1], message[2] === "raw" ? null : Number(message[3]));
}
