import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import { assetInput, assetManifest, assertAssetReady, outboxStorage, OUTBOX_TTL, type OutboxAsset, type OutboxReference } from "./outbox-model";

export async function ownedAsset(env: Env, identity: Identity, id: string): Promise<OutboxAsset> {
  const row = await env.DB.prepare("SELECT * FROM outbox_assets WHERE id=? AND user_id=?").bind(id, identity.userId).first<OutboxAsset>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
export async function reserveAsset(env: Env, identity: Identity, key: string, body: Record<string, unknown>) {
  outboxStorage(env); const input = assetInput(body);
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const hash = await tokenHash(JSON.stringify(input));
  const existing = () => env.DB.prepare("SELECT * FROM outbox_assets WHERE user_id=? AND request_key=?").bind(identity.userId, key).first<OutboxAsset>();
  const previous = await existing();
  if (previous) { if (previous.request_hash !== hash) throw new HttpError(409, "idempotency_conflict"); return { row: previous, created: false }; }
  const id = crypto.randomUUID(), now = unixNow();
  const version = await tokenHash(JSON.stringify([id, input.filename, input.mimeType, input.size, input.sha256]));
  const result = await env.DB.prepare(`INSERT INTO outbox_assets
    (id,user_id,request_key,request_hash,version,object_key,filename,mime_type,size,sha256,state,created_at,updated_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,'reserved',?,?,? WHERE
      (SELECT COALESCE(SUM(size),0) FROM outbox_assets WHERE user_id=? AND cleanup_at IS NULL)+?<=16777216 AND
      (SELECT COALESCE(SUM(size),0) FROM outbox_assets WHERE cleanup_at IS NULL)+?<=268435456 AND
      (SELECT COUNT(*) FROM outbox_assets WHERE user_id=? AND created_at>=?)<10 AND
      (SELECT COUNT(*) FROM outbox_assets WHERE user_id=? AND created_at>=?)<20 AND
      (SELECT COUNT(*) FROM outbox_assets WHERE created_at>=?)<50 AND
      (SELECT COUNT(*) FROM outbox_assets WHERE created_at>=?)<200
    ON CONFLICT(user_id,request_key) DO NOTHING`)
    .bind(id, identity.userId, key, hash, version, `outbox/v1/${identity.userId}/${id}`, input.filename, input.mimeType, input.size, input.sha256,
      now, now, now + OUTBOX_TTL, identity.userId, input.size, input.size, identity.userId, now - 60,
      identity.userId, Math.floor(now / 86400) * 86400, now - 60, Math.floor(now / 86400) * 86400).run();
  const row = await existing();
  if (!row) throw new HttpError(429, "outbox_upload_quota_exceeded");
  if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
  return { row, created: !!result.meta.changes };
}
export async function resolveAssets(env: Env, identity: Identity, references: OutboxReference[]) {
  const assets: OutboxAsset[] = [];
  for (const reference of references) {
    const row = await ownedAsset(env, identity, reference.id); assertAssetReady(row);
    if (row.version !== reference.version) throw new HttpError(409, "outbox_attachment_unavailable"); assets.push(row);
  }
  return { assets, manifests: assets.map(assetManifest) };
}
