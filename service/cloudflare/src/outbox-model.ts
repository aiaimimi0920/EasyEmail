import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import { attachmentFilename } from "./attachment-policy";

export const OUTBOX_FILE_BYTES = 2 * 1024 * 1024;
export const OUTBOX_MESSAGE_BYTES = 3 * 1024 * 1024;
export const OUTBOX_FILES = 5;
export const OUTBOX_TTL = 86400;
export interface OutboxReference { id: string; version: string }
export interface OutboxManifest extends OutboxReference { filename: string; mimeType: string; size: number; sha256: string; expiresAt: number }
export interface OutboxAsset {
  id: string; user_id: string; request_key: string; request_hash: string; version: string; object_key: string;
  filename: string; mime_type: string; size: number; sha256: string; state: "reserved" | "ready" | "deleted" | "expired";
  object_version: string | null; object_etag: string | null; upload_token: string | null; upload_until: number | null;
  created_at: number; updated_at: number; expires_at: number; cleanup_at: number | null;
}
export function outboxStorage(env: Env): R2Bucket {
  if (!env.OUTBOX) throw new HttpError(503, "outbox_storage_unavailable");
  return env.OUTBOX;
}
export const assetManifest = (row: OutboxAsset): OutboxManifest => ({ id: row.id, version: row.version,
  filename: row.filename, mimeType: row.mime_type, size: row.size, sha256: row.sha256, expiresAt: row.expires_at });
export const assetView = (row: OutboxAsset) => ({ ...assetManifest(row),
  state: row.state === "deleted" ? "deleted" : row.expires_at <= unixNow() ? "expired" : row.state,
  cleanupPending: (row.state === "deleted" || row.state === "expired" || row.expires_at <= unixNow()) && row.cleanup_at === null });
export function assertAssetReady(row: OutboxAsset): void {
  if (row.state !== "ready" || row.expires_at <= unixNow()) throw new HttpError(409, "outbox_attachment_unavailable");
}
export function assetInput(body: Record<string, unknown>) {
  if (Object.keys(body).some(k => !["filename", "mimeType", "size", "sha256"].includes(k))
    || typeof body.filename !== "string" || !body.filename || Array.from(body.filename).length > 120 || /[\p{Cc}\p{Cf}]/u.test(body.filename)
    || typeof body.mimeType !== "string" || body.mimeType.length > 100 || !/^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(body.mimeType)
    || !Number.isSafeInteger(body.size) || (body.size as number) < 1 || (body.size as number) > OUTBOX_FILE_BYTES
    || typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) throw new HttpError(400, "invalid_outbox_attachment");
  return { filename: attachmentFilename(body.filename), mimeType: body.mimeType.toLowerCase(), size: body.size as number, sha256: body.sha256 };
}
