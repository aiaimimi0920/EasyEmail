import { api, ApiError } from "./api";

export interface OutboxReference { id: string; version: string }
export interface OutboxAttachment extends OutboxReference { filename: string; mimeType: string; size: number; sha256: string; expiresAt: number }
export interface OutboxAsset extends OutboxAttachment { state: "reserved" | "ready" | "deleted" | "expired"; cleanupPending: boolean }
export interface UploadMetadata { filename: string; mimeType: string; size: number; sha256: string }
export const OUTBOX_FILE_BYTES = 2097152, OUTBOX_TOTAL_BYTES = 3145728, OUTBOX_MAX_FILES = 5;
export const outboxPath = (id: string) => `/outbox-attachments/${id}`;
export const outboxRefs = (items: OutboxAttachment[] = []) => items.map(({ id, version }) => ({ id, version }));
export async function fileMetadata(file: File): Promise<UploadMetadata> {
  if (file.size < 1 || file.size > OUTBOX_FILE_BYTES) throw new ApiError(400, "invalid_outbox_attachment");
  const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  return { filename: file.name, mimeType: file.type || "application/octet-stream", size: file.size,
    sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("") };
}
export const reserveUpload = (body: UploadMetadata, key: string) => api<{ attachment: OutboxAsset }>("/outbox-attachments", "POST", body, { "idempotency-key": key });
export async function uploadContent(id: string, file: File): Promise<OutboxAsset> {
  const response = await fetch(`/api/v1${outboxPath(id)}/content`, { method: "PUT", body: file,
    headers: { "content-type": "application/octet-stream" }, credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(30000) });
  const value = await response.json();
  if (!response.ok) throw new ApiError(response.status, value.error?.code ?? "outbox_upload_unconfirmed");
  return value.attachment;
}
