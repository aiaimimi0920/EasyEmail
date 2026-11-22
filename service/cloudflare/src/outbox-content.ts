import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { assetView, assertAssetReady, outboxStorage, type OutboxAsset } from "./outbox-model";
import { boundedAssetBytes, bytesDigest } from "./outbox-bytes";
import { ownedAsset } from "./outbox-store";
import { cleanAssetObject } from "./outbox-cleanup";
import { attachmentDisposition } from "./attachment-policy";

export async function readAssetObject(env: Env, row: OutboxAsset) {
  const object = await outboxStorage(env).get(row.object_key, row.object_etag ? { onlyIf: { etagMatches: row.object_etag } } : {});
  if (!object || !("body" in object) || !object.body || object.size !== row.size || (row.object_version && object.version !== row.object_version)) {
    throw new HttpError(409, "outbox_attachment_unavailable");
  }
  const bytes = await boundedAssetBytes(object.body, row.size);
  if (bytes.length !== row.size || await bytesDigest(bytes) !== row.sha256) throw new HttpError(409, "outbox_attachment_unavailable");
  return { bytes, version: object.version, etag: object.etag };
}
export async function completeAsset(env: Env, identity: Identity, id: string) {
  const row = await ownedAsset(env, identity, id);
  if (!["reserved", "ready"].includes(row.state) || row.expires_at <= unixNow()) throw new HttpError(409, "outbox_attachment_unavailable");
  const object = await readAssetObject(env, row);
  await env.DB.prepare(`UPDATE outbox_assets SET state='ready',object_version=?,object_etag=?,upload_token=NULL,upload_until=NULL,updated_at=unixepoch()
    WHERE id=? AND user_id=? AND state='reserved' AND expires_at>unixepoch()`)
    .bind(object.version, object.etag, id, identity.userId).run();
  const current = await ownedAsset(env, identity, id); assertAssetReady(current);
  if (current.object_version !== object.version || current.object_etag !== object.etag) throw new HttpError(409, "outbox_attachment_unavailable");
  return current;
}
export async function uploadAsset(request: Request, env: Env, identity: Identity, id: string) {
  const storage = outboxStorage(env), row = await ownedAsset(env, identity, id);
  if (!["reserved", "ready"].includes(row.state) || row.expires_at <= unixNow()) throw new HttpError(409, "outbox_attachment_unavailable");
  if (request.headers.get("content-type") !== "application/octet-stream" || (request.headers.has("content-encoding") && request.headers.get("content-encoding") !== "identity")) {
    throw new HttpError(415, "outbox_binary_required");
  }
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== row.size)) throw new HttpError(400, "invalid_outbox_content");
  const token = crypto.randomUUID();
  if (row.state === "reserved") {
    const claim = await env.DB.prepare(`UPDATE outbox_assets SET upload_token=?,upload_until=unixepoch()+120
      WHERE id=? AND user_id=? AND state='reserved' AND expires_at>unixepoch() AND (upload_until IS NULL OR upload_until<=unixepoch())`)
      .bind(token, id, identity.userId).run();
    if (!claim.meta.changes) throw new HttpError(409, "outbox_upload_in_progress");
  }
  try {
    const bytes = await boundedAssetBytes(request.body, row.size);
    if (bytes.length !== row.size || await bytesDigest(bytes) !== row.sha256) throw new HttpError(400, "invalid_outbox_content");
    if (row.state !== "ready") await storage.put(row.object_key, bytes, { onlyIf: new Headers({ "if-none-match": "*" }), sha256: row.sha256,
      customMetadata: { owner: row.user_id, asset: row.id, sha256: row.sha256 } });
    return await completeAsset(env, identity, id);
  } catch (error) {
    const current = await ownedAsset(env, identity, id);
    if (["deleted", "expired"].includes(current.state)) await cleanAssetObject(env, current);
    if (error instanceof HttpError) throw error;
    throw new HttpError(503, "outbox_upload_unconfirmed");
  } finally {
    await env.DB.prepare("UPDATE outbox_assets SET upload_token=NULL,upload_until=NULL WHERE id=? AND upload_token=? AND state='reserved'")
      .bind(id, token).run();
  }
}
export async function downloadAsset(env: Env, identity: Identity, id: string): Promise<Response> {
  const row = await ownedAsset(env, identity, id); assertAssetReady(row);
  const { bytes } = await readAssetObject(env, row); const current = await ownedAsset(env, identity, id); assertAssetReady(current);
  if (current.version !== row.version) throw new HttpError(409, "outbox_attachment_unavailable");
  return new Response(bytes, { headers: { "content-type": "application/octet-stream", "content-disposition": attachmentDisposition(row.filename),
    "content-length": String(bytes.length), "cache-control": "no-store", "x-content-type-options": "nosniff" } });
}
