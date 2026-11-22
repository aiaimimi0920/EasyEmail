import type { Env } from "./contracts";
import { HttpError } from "./http";
import { claimValues, receiveClaimFence, receiveStateTable, type InboxClaim } from "./normal-inbox-claim";
import type { InboxManifest, InboxPlan } from "./normal-inbox-plan";
import type { NormalMimeContent } from "./normal-mime-content";
import { normalProjection } from "./normal-search-index";
import { normalThreadStatements } from "./normal-thread-store";
import { normalSubscriptionStatements } from "./normal-subscription-cache";
import { NORMAL_INBOX_CAPACITY } from "./normal-inbox-capacity";

interface InboxBatch {
  id: string; account_id: string; account_revision: number; from_version: number; source_hash: string;
  epoch_id: string; uid_validity: string; after_uid: number; reset: number; complete: number; manifest: string; status: string;
  item_count: number; retired_at: number | null;
  server_folder_id?: string | null;
}
async function verifyInboxObjects(env: Env, manifest: InboxManifest) {
  if (!env.INBOX) throw new HttpError(503, "normal_inbox_not_configured");
  for (const item of manifest.items) {
    for (const [key, size, digest] of [[item.rawKey, item.rawBytes, item.rawSha256], [item.contentKey, item.contentBytes, item.contentSha256]] as const) {
      const object = await env.INBOX.head(key);
      const checksum = object?.checksums.sha256;
      const actual = checksum && Array.from(new Uint8Array(checksum), byte => byte.toString(16).padStart(2, "0")).join("");
      if (!object || object.size !== size || actual !== digest) throw new HttpError(503, "normal_inbox_storage_failed");
    }
  }
}
export async function stageNormalInbox(env: Env, claim: InboxClaim, plan: InboxPlan) {
  // Pending intents count towards limits: failed R2 writes must not create unbounded, untracked objects.
  const result = await env.DB.prepare(`INSERT INTO normal_inbox_batches
    (id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,request_id,status,created_at${claim.serverFolder ? ",server_folder_id,server_request_id" : ""})
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,'staged',unixepoch()${claim.serverFolder ? ",?,?" : ""} WHERE ${receiveClaimFence(claim)}
    AND ${NORMAL_INBOX_CAPACITY}`)
    .bind(claim.token, claim.accountId, claim.revision, claim.sourceHash, claim.version, plan.epochId, plan.uidValidity,
      plan.afterUid, Number(plan.reset), Number(plan.complete), plan.manifest.items.length, plan.storageBytes, JSON.stringify(plan.manifest), claim.serverFolder ? null : claim.requestId ?? null,
      ...(claim.serverFolder ? [claim.serverFolder.id, claim.requestId ?? null] : []),
      ...claimValues(claim), claim.accountId, plan.manifest.items.length, plan.storageBytes).run();
  if (!result.meta.changes) throw new HttpError(409, "normal_inbox_changed_or_limit");
}
export async function commitNormalInbox(env: Env, claim: InboxClaim, contents?: Map<string, NormalMimeContent>) {
  const batch = await env.DB.prepare("SELECT * FROM normal_inbox_batches WHERE id=? AND account_id=?")
    .bind(claim.token, claim.accountId).first<InboxBatch>();
  if (!batch || batch.retired_at !== null || batch.account_revision !== claim.revision || batch.from_version !== claim.version || batch.source_hash !== claim.sourceHash
    || (batch.server_folder_id ?? null) !== (claim.serverFolder?.id ?? null)) {
    throw new HttpError(409, "normal_inbox_changed");
  }
  const manifest = JSON.parse(batch.manifest) as InboxManifest;
  const committed = `EXISTS (SELECT 1 FROM normal_inbox_batches b JOIN ${receiveStateTable(claim)} s ON s.account_id=b.account_id
    ${claim.serverFolder ? "AND s.server_folder_id=b.server_folder_id" : ""}
    WHERE b.id=? AND b.status='committed' AND s.version=b.from_version AND s.claim_token=b.id)`;
  if (batch.status !== "committed") {
    await verifyInboxObjects(env, manifest);
    const statements = [env.DB.prepare(`UPDATE normal_inbox_batches SET status='committed',committed_at=unixepoch()
      WHERE id=? AND status='staged' AND retired_at IS NULL AND ${receiveClaimFence(claim)}`).bind(claim.token, ...claimValues(claim))];
    for (const item of manifest.items) statements.push(env.DB.prepare(`INSERT INTO normal_inbox_messages
      (id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,summary,observed_at${claim.serverFolder ? ",server_folder_id" : ""})
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch()${claim.serverFolder ? ",?" : ""} WHERE ${committed}`)
      .bind(item.id, claim.accountId, claim.token, batch.epoch_id, batch.uid_validity, item.uid, item.rawKey, item.contentKey,
        item.rawSha256, item.contentSha256, item.rawBytes, item.contentBytes, item.receivedAt, JSON.stringify(item.flags), item.summary ? JSON.stringify(item.summary) : null,
        ...(claim.serverFolder ? [claim.serverFolder.id] : []), claim.token));
    for (const item of manifest.items) {
      const content = contents?.get(item.id);
      if (content) {
        statements.push(normalProjection(env, item.id, item.contentSha256, content, committed, [claim.token]));
        statements.push(...await normalThreadStatements(env, claim.userId, claim.accountId, batch.epoch_id,
          { where: `m.id=? AND ${committed}`, values: [item.id, claim.token] }, content));
        statements.push(...await normalSubscriptionStatements(env, claim.userId, claim.accountId, batch.epoch_id,
          { where: `m.id=? AND ${committed}`, values: [item.id, claim.token] }, content));
      }
    }
    statements.push(env.DB.prepare(`UPDATE ${receiveStateTable(claim)} SET source_hash=?,epoch_id=?,uid_validity=?,after_uid=?,version=version+1,
      updated_at=unixepoch(),claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL WHERE account_id=? AND version=?
      ${claim.serverFolder ? "AND server_folder_id=?" : ""} AND ${committed}`)
      .bind(claim.sourceHash, batch.epoch_id, batch.uid_validity, batch.after_uid, claim.accountId, claim.version,
        ...(claim.serverFolder ? [claim.serverFolder.id] : []), claim.token));
    let changed = false;
    try { changed = !!(await env.DB.batch(statements))[0].meta.changes; }
    catch (error) {
      // A lost batch response is not proof of rollback. Reconcile this exact intent before reporting failure.
      if (!(await env.DB.prepare("SELECT 1 FROM normal_inbox_batches WHERE id=? AND status='committed'").bind(claim.token).first())) throw error;
      changed = true;
    }
    if (!changed && !(await env.DB.prepare("SELECT 1 FROM normal_inbox_batches WHERE id=? AND status='committed'")
      .bind(claim.token).first())) throw new HttpError(409, "normal_inbox_changed");
  }
  return { batchId: batch.id, accountRevision: batch.account_revision, epochId: batch.epoch_id,
    cursor: { uidValidity: batch.uid_validity, afterUid: batch.after_uid }, stored: batch.item_count,
    skipped: manifest.skipped, reset: !!batch.reset, complete: !!batch.complete };
}
