import assert from "node:assert/strict";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";

export const draftPath = (id = "") => `/api/v1/drafts${id ? `/${id}` : ""}`;
export const draftBody = (mailboxId = null, extra = {}) => ({ expectedRevision: 0, mailboxId,
  to: "recipient@example.test", subject: "云端草稿", text: "跨设备继续编辑", replyToMessageId: null, ...extra });
export const saveDraft = (h, cookie, id, body, extra = {}) => h.request(draftPath(id), { method: "PUT", cookie, body, ...extra });
export const deleteDraft = (h, cookie, id, expectedRevision, extra = {}) => h.request(draftPath(id), {
  method: "DELETE", cookie, body: { expectedRevision }, ...extra });
export const ok = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.body.draft; };

export async function draftFixture() {
  const h = await createHarness();
  try {
    const alice = await h.register("draft-alice"), bob = await h.register("draft-bob");
    const box = await seedMailbox(h, alice.id, "draft@example.test");
    return { h, alice, bob, box, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}
