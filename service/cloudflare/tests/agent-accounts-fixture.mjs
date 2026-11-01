import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";

export const AGENT_PASSWORD = "Synthetic-Agent-app-password-8593";
export const agentBindings = {
  IMAP_ENDPOINTS: JSON.stringify([{ id: "example", label: "Agent test IMAP", hostname: "imap.example.test", port: 993 },
    { id: "google", label: "Google OAuth", hostname: "imap.gmail.com", port: 993, authentication: "google-oauth2" }]),
  MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }),
};
export const agentAccountInput = { expectedRevision: 0, emailAddress: "Agent@example.test", displayName: "Agent 专用邮箱",
  endpointId: "example", username: "Agent", password: AGENT_PASSWORD, enabled: true };
export const expect = (r, status = 200) => { assert.equal(r.status, status, r.text); return r.body; };
export const agentWrite = (h, user, id, body = agentAccountInput, key = crypto.randomUUID(), extra = {}) => h.request(`/api/v1/agent-accounts/${id}`, {
  method: "PUT", cookie: user.cookie, body, ...extra, headers: { "idempotency-key": key, ...extra.headers },
});
export const agentDelete = (h, user, id, revision, key = crypto.randomUUID()) => h.request(`/api/v1/agent-accounts/${id}`, {
  method: "DELETE", cookie: user.cookie, headers: { "idempotency-key": key }, body: { expectedRevision: revision },
});
export async function agentAccountsFixture(overrides = {}, entry = null, through = null) {
  const h = await createHarness({ ...agentBindings, ...overrides }, false, through, entry);
  try {
    const alice = await h.register("agent-account-alice"), bob = await h.register("agent-account-bob");
    return { h, alice, bob, close: () => h.close() };
  } catch (error) { await h.close(); throw error; }
}
