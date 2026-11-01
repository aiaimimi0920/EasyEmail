import { HttpError } from "./http";

export async function bytesDigest(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("");
}
export async function boundedAssetBytes(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!stream) throw new HttpError(400, "invalid_outbox_content");
  const reader = stream.getReader(), bytes = new Uint8Array(limit); let length = 0, timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => {
    void reader.cancel().catch(() => {}); reject(new HttpError(408, "outbox_upload_timeout"));
  }, 20000); });
  try {
    while (true) {
      const { value, done } = await Promise.race([reader.read(), deadline]); if (done) break;
      if (length + value.byteLength > limit) { void reader.cancel().catch(() => {}); throw new HttpError(413, "outbox_content_too_large"); }
      bytes.set(value, length); length += value.byteLength;
    }
    return bytes.slice(0, length);
  } finally { clearTimeout(timer!); reader.releaseLock(); }
}
export function assetBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 16384) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
  return btoa(chunks.join(""));
}
