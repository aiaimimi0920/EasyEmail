import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { identityCredentialFence, requireScope } from "./identity";
import type { NormalStoredMessage } from "./normal-inbox-access";
import { normalStateColumns, normalStateJoin } from "./normal-message-state";
import { normalSearchContexts, normalSearchJoin, normalSearchVisible, type NormalSearchContext } from "./normal-search-context";
import { jobSendFence, type JobClaim } from "./send-job-reservation";

export interface NormalReplySource {
  id: string; accountId: string; accountRevision: number; rawHash: string; contentHash: string; context: NormalSearchContext;
}
export interface NormalReplyOptions { folderId?: string; claim?: JobClaim }

function callerFence(identity: Identity, claim?: JobClaim) {
  if (!claim) return { sql: identityCredentialFence(identity), values: [identity.credentialId, identity.userId] };
  // Only the normal queue's internal, still-live claim can replace an HTTP credential.
  return claim.source === "normal" && claim.user_id === identity.userId ? jobSendFence(claim) : { sql: "0", values: [] };
}
export function normalReplySourceFence(identity: Identity, reply: NormalReplySource, claim?: JobClaim) {
  const contexts = [reply.context], caller = callerFence(identity, claim);
  const watermark = reply.context.folderSchema ? "COALESCE(fs.after_uid,s.after_uid,0)" : "s.after_uid";
  return {
    sql: `EXISTS (SELECT 1 FROM normal_inbox_messages m ${normalSearchJoin(contexts)} ${normalStateJoin}
      WHERE ${normalSearchVisible} AND m.id=? AND m.raw_sha256=? AND m.content_sha256=?
      AND ns.trashed_at IS NULL AND m.uid<=${watermark}) AND ${caller.sql}`,
    values: [JSON.stringify(contexts), identity.userId, reply.id, reply.rawHash, reply.contentHash, ...caller.values],
  };
}
export async function assertNormalReplySource(env: Env, identity: Identity, source: NormalReplySource, claim?: JobClaim) {
  const fence = normalReplySourceFence(identity, source, claim);
  if (!await env.DB.prepare(`SELECT 1 WHERE ${fence.sql}`).bind(...fence.values).first()) throw new HttpError(409, "normal_account_changed");
}
export async function normalReplySource(env: Env, identity: Identity, accountId: string, id: string, options: NormalReplyOptions) {
  if (!options.claim) { requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read"); }
  const caller = callerFence(identity, options.claim);
  if (!await env.DB.prepare(`SELECT 1 WHERE ${caller.sql}`).bind(...caller.values).first()) {
    throw new HttpError(options.claim ? 409 : 401, options.claim ? "send_job_reservation_denied" : "unauthorized");
  }
  const contexts = await normalSearchContexts(env, identity, accountId, options.folderId === "" ? "inbox" : "all");
  const locator = await env.DB.prepare("SELECT * FROM normal_inbox_messages WHERE account_id=? AND id=?")
    .bind(accountId, id).first<NormalStoredMessage & { server_folder_id?: string | null }>();
  const folder = locator?.server_folder_id ?? "";
  if (!locator || (options.folderId !== undefined && options.folderId !== folder)) throw new HttpError(404, "not_found");
  const context = contexts.find(item => (item.serverFolderId ?? "") === folder);
  if (!context) throw new HttpError(404, "not_found");
  const row = await env.DB.prepare(`SELECT m.*,${normalStateColumns},${context.folderSchema ? "COALESCE(fs.after_uid,s.after_uid,0)" : "s.after_uid"} AS published_uid
    FROM normal_inbox_messages m ${normalSearchJoin([context])} ${normalStateJoin} WHERE ${normalSearchVisible} AND m.id=?`)
    .bind(JSON.stringify([context]), identity.userId, id).first<NormalStoredMessage & { published_uid: number }>();
  if (!row) throw new HttpError(404, "not_found");
  if (row.trashed_at != null || row.uid > row.published_uid) throw new HttpError(400, "invalid_reply_source");
  const source: NormalReplySource = { id, accountId, accountRevision: context.revision, rawHash: row.raw_sha256, contentHash: row.content_sha256, context };
  return { row, source };
}
