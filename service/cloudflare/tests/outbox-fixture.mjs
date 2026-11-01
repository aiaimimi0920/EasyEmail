import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHarness } from "./runtime-harness.mjs";
import { sendFixture } from "./send-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";

export const assetBytes = Uint8Array.from([0, 255, 128, 13, 10, 65, 66, 0, 239, 127]);
export const bytesHash = bytes => createHash("sha256").update(bytes).digest("hex");
export const assetMetadata = (bytes = assetBytes) => ({ filename: "合成附件.bin", mimeType: "application/octet-stream", size: bytes.length, sha256: bytesHash(bytes) });
export async function outboxFixture({ browser = false, transport = "binding", through = null, entry = null, storage = true, bindings = {} } = {}) {
  const f = await sendFixture(transport), h = await createHarness({ ...f.bindings, ...bindings }, browser, through, entry, storage ? { r2Buckets: { OUTBOX: "outbox-test" } } : {});
  const alice = await h.register(`outbox-${crypto.randomUUID()}`), box = (await allocate(h, alice.cookie)).body.mailbox;
  return { f, h, alice, box,
    async reserve(body = assetMetadata(), key = crypto.randomUUID(), extra = {}) {
      return h.request("/api/v1/outbox-attachments", { method: "POST", cookie: alice.cookie, body, headers: { "idempotency-key": key }, ...extra });
    },
    async upload(bytes = assetBytes, extra = {}) {
      const created = await this.reserve(assetMetadata(bytes)); assert.equal(created.status, 201, created.text);
      const result = await putAsset(h, alice, created.body.attachment.id, bytes, extra); assert.equal(result.status, 200, result.text);
      return result.body.attachment;
    },
    close: async () => { await h.close(); await f.close(); },
  };
}
export async function putAsset(h, user, id, bytes = assetBytes, { headers = {}, origin = h.appOrigin, token } = {}) {
  const response = await fetch(new URL(`/api/v1/outbox-attachments/${id}/content`, h.baseUrl), { method: "PUT", body: bytes,
    headers: { "content-type": "application/octet-stream", ...(origin === null ? {} : { origin }),
      ...(token ? { authorization: `Bearer ${token}` } : { cookie: user.cookie }), ...headers } });
  const text = await response.text(); return { status: response.status, body: JSON.parse(text), text };
}
export const assetRef = asset => ({ id: asset.id, version: asset.version });
