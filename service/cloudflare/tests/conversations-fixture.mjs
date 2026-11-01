import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";
import { providerFixture, allocate, cfMail } from "./provider-fixture.mjs";

export function expect(result, status = 200) { assert.equal(result.status, status, result.text); return result.body; }
export async function conversationFixture(browser = false, through = null, bindings = {}, entry = null) {
  const f = await providerFixture(); let h;
  try {
    h = await createHarness({ ...f.bindings, ...bindings }, browser, through, entry);
    const alice = await h.register("conversation-alice"), bob = await h.register("conversation-bob");
    const box = expect(await allocate(h, alice.cookie), 201).mailbox;
    return { f, h, alice, bob, box, async close() { await h.close(); await f.close(); } };
  } catch (error) { await h?.close(); await f.close(); throw error; }
}
export const threadMail = (box, id, own, refs = "", subject = "Thread", parent = "") => ({
  ...cfMail(box.address, id, `Content ${id}`, `2026-10-28 01:${String(id % 60).padStart(2, "0")}:00`),
  subject, message_id: own, thread_headers: { version: 1, inReplyTo: parent, references: refs },
});
export async function sync(fixture, box = fixture.box, page = 1) {
  return expect(await fixture.h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: fixture.alice.cookie, method: "POST", body: { page } })).sync;
}
export const conversations = (h, user, query = "folder=all", extra = {}) => h.request(`/api/v1/conversations?${query}`, { cookie: user.cookie, ...extra });
export const members = (h, user, id, query = "folder=all", extra = {}) => h.request(`/api/v1/conversations/${id}/messages?${query}`, { cookie: user.cookie, ...extra });
