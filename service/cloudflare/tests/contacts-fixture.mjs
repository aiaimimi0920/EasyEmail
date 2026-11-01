import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";

export async function contactsFixture(overrides = {}, browser = false, through = null, entry = null) {
  const h = await createHarness(overrides, browser, through, entry);
  try {
    const alice = await h.register("contacts-alice"), bob = await h.register("contacts-bob");
    return { h, alice, bob, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}
export const contactBody = (emailAddress = "alice@example.test", displayName = "Alice", note = "private note") => ({ emailAddress, displayName, note });
export const expect = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.body; };
export const contactWrite = (h, user, method, id, body, key = crypto.randomUUID(), extra = {}) => h.request(`/api/v1/contacts${id ? `/${id}` : ""}`, {
  cookie: user.cookie, method, body, ...extra, headers: { "idempotency-key": key, ...extra.headers },
});
export const saveContact = (h, user, body = contactBody(), key, extra) => contactWrite(h, user, "POST", null, body, key, extra);
export const getContact = (h, user, id, extra = {}) => h.request(`/api/v1/contacts/${id}`, { cookie: user.cookie, ...extra });
