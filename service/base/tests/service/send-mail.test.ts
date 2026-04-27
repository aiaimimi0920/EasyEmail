import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const providerType: ProviderTypeDefinition = {
  key: "cloudflare_temp_email",
  displayName: "Cloudflare Temp Email",
  description: "Cloudflare provider",
  supportsDynamicProvisioning: true,
  defaultStrategyKey: "dynamic-priority",
  tags: ["internal", "runtime"],
};

const providerInstance: ProviderInstance = {
  id: "cloudflare_temp_email_shared_default",
  providerTypeKey: "cloudflare_temp_email",
  displayName: "Cloudflare Temp Email Shared Runtime",
  status: "active",
  runtimeKind: "cloudflare_temp_email-runtime",
  connectorKind: "cloudflare_temp_email-connector",
  shared: true,
  costTier: "paid",
  healthScore: 1,
  averageLatencyMs: 100,
  connectionRef: "https://mail.example.test",
  hostBindings: [],
  groupKeys: [],
  metadata: {
    baseUrl: "https://mail.example.test",
    customAuth: "custom-auth",
    adminAuth: "admin-auth",
  },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const adapter: MailProviderAdapter = {
  typeKey: "cloudflare_temp_email",
  async createMailboxSession({ request, instance, now }) {
    return {
      id: "mailbox_20260401000000_0001",
      hostId: request.hostId,
      providerTypeKey: "cloudflare_temp_email",
      providerInstanceId: instance.id,
      emailAddress: "sender@mail.example.test",
      mailboxRef: "cloudflare_temp_email:sender",
      status: "open",
      createdAt: now.toISOString(),
      metadata: { ...(request.metadata ?? {}) },
    };
  },
  async sendMailboxMessage({ session, instance, request, now }) {
    return {
      sessionId: session.id,
      providerTypeKey: session.providerTypeKey,
      providerInstanceId: instance.id,
      senderEmailAddress: session.emailAddress,
      recipientEmailAddress: request.toEmailAddress,
      sentAt: now.toISOString(),
      deliveryMode: "admin_delegate",
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "CLOUDFLARE_OK",
      averageLatencyMs: 100,
    };
  },
};

describe("EasyEmailService mailbox sending", () => {
  it("routes mailbox sending through the provider adapter for opened sessions", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: [providerInstance],
      adapters: [adapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "cloudflare_temp_email",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, new Date("2026-04-01T00:00:00.000Z"));

    const result = await service.sendMailboxMessage({
      sessionId: opened.session.id,
      toEmailAddress: "receiver@example.com",
      subject: "Verification code",
      textBody: "Your verification code is 112233.",
      fromName: "Matrix Sender",
    }, new Date("2026-04-01T00:01:00.000Z"));

    expect(result).toEqual({
      sessionId: opened.session.id,
      providerTypeKey: "cloudflare_temp_email",
      providerInstanceId: providerInstance.id,
      senderEmailAddress: "sender@mail.example.test",
      recipientEmailAddress: "receiver@example.com",
      sentAt: "2026-04-01T00:01:00.000Z",
      deliveryMode: "admin_delegate",
    });
  });
});
