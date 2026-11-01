import assert from "node:assert/strict";
import { createHarness, seedMailbox } from "./runtime-harness.mjs";

export const labelPath = id => `/api/v1/labels${id ? `/${id}` : ""}`;
export const labelBody = (name = "项目", expectedRevision = 0, color = "blue") => ({ name, expectedRevision, color });
export const putLabel = (h, user, id, body = labelBody(), extra = {}) => h.request(labelPath(id), { cookie: user.cookie, method: "PUT", body, ...extra });
export const organize = (h, user, body, key = crypto.randomUUID(), extra = {}) => h.request("/api/v1/messages/organize", {
  cookie: user.cookie, method: "POST", body, headers: { "idempotency-key": key }, ...extra });
export const messageLabels = (h, user, box, id, extra = {}) => h.request(`/api/v1/mailboxes/${box}/messages/${id}/labels`, { cookie: user.cookie, ...extra });
export const expect = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };

export async function seedMessage(h, userId, box, index) {
  const id = crypto.randomUUID();
  await h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
    VALUES(?,?,?,?,?,'sender@example.test','target@example.test',?,'body','','[]',?,?)`)
    .bind(id, userId, box, `remote-${index}`, `hash-${index}`, `整理邮件 ${index}`, 1000 + index, 1000 + index).run();
  return id;
}

export async function labelsFixture(options = {}, browser = false, through = null, entry = null) {
  const h = await createHarness(options, browser, through, entry);
  try {
    const alice = await h.register("labels-alice"), bob = await h.register("labels-bob");
    const box = await seedMailbox(h, alice.id, "alice@example.test"), other = await seedMailbox(h, bob.id, "bob@example.test");
    const ids = [await seedMessage(h, alice.id, box, 1), await seedMessage(h, alice.id, box, 2)];
    const foreign = await seedMessage(h, bob.id, other, 3);
    return { h, alice, bob, box, other, ids, foreign, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}
