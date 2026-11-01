import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { NO_PENDING_ASSET } from "./outbox-references";
import { OUTBOX_TTL, type OutboxAsset } from "./outbox-model";
import { ownedAsset } from "./outbox-store";

export async function cleanAssetObject(env: Env, row: OutboxAsset): Promise<boolean> {
  if (!env.OUTBOX || !["deleted", "expired"].includes(row.state)) return false;
  try {
    // Object keys are never re-used; a terminal row can never become ready again.
    await env.OUTBOX.delete(row.object_key);
    await env.DB.prepare("UPDATE outbox_assets SET cleanup_at=unixepoch() WHERE id=? AND state IN ('deleted','expired')").bind(row.id).run();
    return true;
  } catch { return false; }
}
async function expireAsset(env: Env, id: string, cutoff: number) {
  await env.DB.prepare(`UPDATE outbox_assets SET state='expired',filename='',mime_type='application/octet-stream',updated_at=?
    WHERE id=? AND state IN ('reserved','ready') AND expires_at<=? AND ${NO_PENDING_ASSET}`).bind(cutoff, id, cutoff).run();
  return env.DB.prepare("SELECT * FROM outbox_assets WHERE id=?").bind(id).first<OutboxAsset>();
}
export async function removeAsset(env: Env, identity: Identity, id: string) {
  await ownedAsset(env, identity, id);
  await env.DB.prepare(`UPDATE outbox_assets SET state='deleted',filename='',mime_type='application/octet-stream',updated_at=unixepoch()
    WHERE id=? AND user_id=? AND state IN ('reserved','ready') AND ${NO_PENDING_ASSET}`).bind(id, identity.userId).run();
  const row = await ownedAsset(env, identity, id);
  if (!["deleted", "expired"].includes(row.state)) throw new HttpError(409, "outbox_attachment_in_use");
  const cleaned = await cleanAssetObject(env, row);
  return { row: await ownedAsset(env, identity, id), cleaned };
}
async function inventoryCleanup(env: Env, cutoff: number): Promise<number> {
  if (!env.OUTBOX) return 0;
  const cursor = await env.DB.prepare("SELECT cursor FROM outbox_cleanup_state WHERE id='inventory'").first<string | null>("cursor");
  const listing = await env.OUTBOX.list({ prefix: "outbox/v1/", limit: 20, ...(cursor ? { cursor } : {}) }); let cleaned = 0;
  for (const object of listing.objects) {
    if (!/^outbox\/v1\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(object.key)) continue;
    let row = await env.DB.prepare("SELECT * FROM outbox_assets WHERE object_key=?").bind(object.key).first<OutboxAsset>();
    if (row && row.expires_at <= cutoff) row = await expireAsset(env, row.id, cutoff);
    if (row && ["deleted", "expired"].includes(row.state)) { if (await cleanAssetObject(env, row)) cleaned++; }
    // A restored D1 snapshot may lack an old object. Never remove fresh or foreign-prefix objects.
    if (!row && object.uploaded.getTime() / 1000 <= cutoff - OUTBOX_TTL - 300) { await env.OUTBOX.delete(object.key); cleaned++; }
  }
  await env.DB.prepare("UPDATE outbox_cleanup_state SET cursor=? WHERE id='inventory'")
    .bind(listing.truncated ? listing.cursor : null).run();
  return cleaned;
}
export async function cleanupOutbox(env: Env, userId?: string) {
  if (!env.OUTBOX) return { available: false, processed: 0, cleaned: 0, pending: 0, inventoryCleaned: 0 };
  const cutoff = unixNow();
  const { results } = await env.DB.prepare(`SELECT * FROM outbox_assets WHERE (state IN ('deleted','expired') OR expires_at<=?)
    ${userId ? "AND user_id=?" : "AND cleanup_at IS NULL"} ORDER BY COALESCE(cleanup_at,0),expires_at,id LIMIT 20`)
    .bind(cutoff, ...(userId ? [userId] : [])).all<OutboxAsset>();
  let cleaned = 0;
  for (const candidate of results) {
    const row = await expireAsset(env, candidate.id, cutoff);
    if (row && await cleanAssetObject(env, row)) cleaned++;
  }
  return { available: true, processed: results.length, cleaned, pending: results.length - cleaned,
    inventoryCleaned: userId ? 0 : await inventoryCleanup(env, cutoff) };
}
export async function scheduledOutboxCleanup(env: Env) {
  try { await cleanupOutbox(env); }
  catch { console.error(JSON.stringify({ code: "outbox_cleanup_unconfirmed" })); }
}
