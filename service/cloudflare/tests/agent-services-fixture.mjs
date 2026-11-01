import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";

export async function agentServicesFixture(overrides = {}, browser = false, through = null, entry = null) {
  const h = await createHarness(overrides, browser, through, entry);
  try {
    const alice = await h.register("agent-services-alice"), bob = await h.register("agent-services-bob");
    return { h, alice, bob, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}
export const serviceBody = (emailAddress = "agent@example.test", displayName = "Remote Agent") => ({ emailAddress, displayName });
export const expect = (response, status = 200) => { assert.equal(response.status, status, response.text); return response.body; };
export const serviceWrite = (h, user, method, id, body, key = crypto.randomUUID(), extra = {}) => h.request(`/api/v1/agent-services${id ? `/${id}` : ""}`, {
  cookie: user.cookie, method, body, ...extra, headers: { "idempotency-key": key, ...extra.headers },
});
export const createService = (h, user, body = serviceBody(), key, extra) => serviceWrite(h, user, "POST", null, body, key, extra);
export const getService = (h, user, id, extra = {}) => h.request(`/api/v1/agent-services/${id}`, { cookie: user.cookie, ...extra });
