import assert from "node:assert/strict";
import { normalSendFixture, mailInput } from "./normal-send-fixture.mjs";
import { assetBytes, assetMetadata, putAsset } from "./outbox-fixture.mjs";

export async function normalAttachmentsFixture(browser = false) {
  const t = await normalSendFixture(browser, { r2Buckets: { OUTBOX: "normal-attachments-test" } });
  return { ...t,
    upload: (bytes, metadata) => uploadNormalAsset(t, bytes, metadata),
    save(id, attachments, extra = {}, options = {}) {
      return t.h.request(`${t.path}/drafts/${id}`, { method: "PUT", cookie: t.alice.cookie,
        body: { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: mailInput.subject, text: mailInput.text, attachments, ...extra }, ...options });
    },
    remove(id) { return t.h.request(`/api/v1/outbox-attachments/${id}`, { method: "DELETE", cookie: t.alice.cookie, body: {} }); },
  };
}
export async function uploadNormalAsset(t, bytes = assetBytes, metadata = {}) {
  const reserved = await t.h.request("/api/v1/outbox-attachments", { method: "POST", cookie: t.alice.cookie,
    headers: { "idempotency-key": crypto.randomUUID() }, body: { ...assetMetadata(bytes), ...metadata } });
  assert.equal(reserved.status, 201, reserved.text);
  const result = await putAsset(t.h, t.alice, reserved.body.attachment.id, bytes); assert.equal(result.status, 200, result.text);
  return result.body.attachment;
}
