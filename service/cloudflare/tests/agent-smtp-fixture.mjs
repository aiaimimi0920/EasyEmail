import { createHarness } from "./runtime-harness.mjs";
import { agentBindings, agentWrite, expect } from "./agent-accounts-fixture.mjs";

export const AGENT_SMTP_PASSWORD = "Synthetic-Agent-SMTP-password-4739";
export const agentSmtpBindings = { SMTP_ENDPOINTS: JSON.stringify([
  { id: "smtp", label: "Agent SMTP TLS", hostname: "smtp.example.test", port: 465, recipients: ["*"] },
  { id: "starttls", label: "Agent SMTP STARTTLS", hostname: "smtp.example.test", port: 587, security: "starttls", recipients: ["*"] },
  { id: "google", label: "Google OAuth SMTP", hostname: "smtp.gmail.com", port: 465, recipients: ["*"], authentication: "google-oauth2" },
]) };
export const agentSmtpInput = { expectedRevision: 1, smtpRevision: 0, endpointId: "smtp", username: "Agent-SMTP",
  password: AGENT_SMTP_PASSWORD, enabled: true };
export async function agentSmtpFixture({ bindings = {}, entry = null, through = null, browser = false, resources = {} } = {}) {
  const h = await createHarness({ ...agentBindings, ...agentSmtpBindings, ...bindings }, browser, through, entry, resources);
  try {
    const alice = await h.register("agent-smtp-alice"), bob = await h.register("agent-smtp-bob"), id = crypto.randomUUID();
    expect(await agentWrite(h, alice, id), 201);
    const route = `/api/v1/agent-accounts/${id}/smtp`;
    return { h, alice, bob, id, route, close: () => h.close(),
      configure: (body = agentSmtpInput, key = crypto.randomUUID(), extra = {}) => h.request(route, {
        cookie: alice.cookie, method: "PUT", body, ...extra, headers: { "idempotency-key": key, ...extra.headers },
      }),
      read: () => h.request(route, { cookie: alice.cookie }),
    };
  } catch (error) { await h.close(); throw error; }
}
