import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { OUTBOX_MESSAGE_BYTES, outboxStorage, type OutboxReference } from "./outbox-model";
import { resolveAssets } from "./outbox-store";
import { readAssetObject } from "./outbox-content";
import { assetBase64 } from "./outbox-bytes";

export async function outgoingAssets(env: Env, identity: Identity, references: OutboxReference[]) {
  if (!references.length) return { manifests: [], attachments: [] };
  try { return await loadOutgoingAssets(env, identity, references); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(503, "outbox_storage_failed"); }
}
async function loadOutgoingAssets(env: Env, identity: Identity, references: OutboxReference[]) {
  outboxStorage(env); const { assets, manifests } = await resolveAssets(env, identity, references);
  if (assets.reduce((total, row) => total + row.size, 0) > OUTBOX_MESSAGE_BYTES) throw new HttpError(413, "outbox_message_too_large");
  // A conservative 3 MiB raw cap leaves room for base64 folding, headers and bounded text under 5 MiB.
  const encoded = assets.reduce((total, row) => { const n = 4 * Math.ceil(row.size / 3); return total + n + 2 * Math.ceil(n / 76) + 2048; }, 262144);
  if (encoded > 5 * 1024 * 1024) throw new HttpError(413, "outbox_message_too_large");
  const attachments: { filename: string; type: string; disposition: "attachment"; content: string }[] = [];
  for (const row of assets) {
    const { bytes } = await readAssetObject(env, row);
    attachments.push({ filename: row.filename, type: row.mime_type, disposition: "attachment", content: assetBase64(bytes) });
  }
  return { manifests, attachments };
}
