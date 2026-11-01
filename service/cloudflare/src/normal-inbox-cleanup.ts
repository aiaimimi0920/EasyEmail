import { unixNow, type Env } from "./contracts";
import { normalReceiveLeaseTable } from "./normal-retention-selection";

export const NORMAL_OBJECT_CLEANUP_LIMIT = 20;
export async function normalInboxCleanupStatus(env: Env) {
  const pending = await env.DB.prepare("SELECT COUNT(*) n FROM normal_inbox_object_deletions WHERE cleaned_at IS NULL").first<number>("n");
  return { available: !!env.INBOX, pending: pending ?? 0, batchLimit: NORMAL_OBJECT_CLEANUP_LIMIT };
}
interface Deletion { object_key: string; batch_id: string; account_id: string; user_id: string }
const deletionQuery = (leaseTable: string) => `SELECT d.object_key,d.batch_id,b.account_id,a.user_id FROM normal_inbox_object_deletions d
  JOIN normal_inbox_batches b ON b.id=d.batch_id JOIN normal_accounts a ON a.id=b.account_id
  WHERE (b.status='committed' OR b.retired_at IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM normal_inbox_messages m WHERE m.purged_at IS NULL AND (m.raw_key=d.object_key OR m.content_key=d.object_key))
  AND NOT EXISTS (SELECT 1 FROM ${leaseTable} s WHERE s.account_id=b.account_id AND s.claim_token=b.id AND s.claim_lease_until>unixepoch())`;
function ownsObject(row: Deletion) {
  const prefix = `normal-inbox/v1/${row.user_id}/${row.account_id}/${row.batch_id}/`;
  if (!row.object_key.startsWith(prefix)) return false;
  const suffix = row.object_key.slice(prefix.length), match = /^([1-9]\d{0,9})\.(?:eml|json)$/.exec(suffix);
  return !!match && Number(match[1]) <= 4294967295;
}
async function cleanObject(env: Env, candidate: Deletion, query: string) {
  // Re-check authoritative intent immediately before I/O. Terminal keys cannot be re-used by this runtime.
  const row = await env.DB.prepare(`${query} AND d.object_key=?`).bind(candidate.object_key).first<Deletion>();
  if (!row || !ownsObject(row) || !env.INBOX) return false;
  try {
    await env.INBOX.delete(row.object_key);
    // Capacity is released only after R2 acknowledgement and an atomic accounting update.
    await env.DB.batch([
      env.DB.prepare("UPDATE normal_inbox_object_deletions SET cleaned_at=? WHERE object_key=?").bind(unixNow(), row.object_key),
      env.DB.prepare(`UPDATE normal_inbox_batches SET released_bytes=COALESCE((SELECT SUM(size_bytes)
        FROM normal_inbox_object_deletions WHERE batch_id=? AND cleaned_at IS NOT NULL),0) WHERE id=?`).bind(row.batch_id, row.batch_id),
    ]);
    return true;
  } catch { return false; }
}
async function cleanInventory(env: Env, query: string) {
  if (!env.INBOX) return 0;
  const cursor = await env.DB.prepare("SELECT cursor FROM normal_inbox_cleanup_state WHERE id=1").first<string | null>("cursor");
  const listing = await env.INBOX.list({ prefix: "normal-inbox/v1/", limit: NORMAL_OBJECT_CLEANUP_LIMIT, ...(cursor ? { cursor } : {}) });
  let cleaned = 0;
  for (const object of listing.objects) {
    // A late put may arrive after its lease was retired and the first delete was acknowledged.
    // Unknown objects (including snapshot mismatches) are never eligible merely because of age.
    const row = await env.DB.prepare(`${query} AND d.object_key=?`).bind(object.key).first<Deletion>();
    if (row && await cleanObject(env, row, query)) cleaned++;
  }
  await env.DB.prepare("UPDATE normal_inbox_cleanup_state SET cursor=? WHERE id=1").bind(listing.truncated ? listing.cursor : null).run();
  return cleaned;
}
export async function cleanupNormalInbox(env: Env) {
  if (!env.INBOX) return { available: false, processed: 0, cleaned: 0, inventoryCleaned: 0 };
  const query = deletionQuery(await normalReceiveLeaseTable(env));
  const rows = (await env.DB.prepare(`${query} AND d.cleaned_at IS NULL ORDER BY d.created_at,d.object_key LIMIT ${NORMAL_OBJECT_CLEANUP_LIMIT}`).all<Deletion>()).results;
  let cleaned = 0;
  for (const row of rows) if (await cleanObject(env, row, query)) cleaned++;
  return { available: true, processed: rows.length, cleaned, inventoryCleaned: await cleanInventory(env, query) };
}
export async function maintainNormalInbox(env: Env) {
  try { return await cleanupNormalInbox(env); }
  catch { console.error(JSON.stringify({ code: "normal_inbox_cleanup_unconfirmed" })); return null; }
}
