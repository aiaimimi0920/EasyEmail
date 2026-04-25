import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm",
  description: "Mail.tm provider",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["free"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm_shared_default",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm Default",
  status: "active",
  runtimeKind: "external",
  connectorKind: "mailtm-client",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 100,
  connectionRef: "https://api.mail.tm",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const mailboxAdapter: MailProviderAdapter = {
  typeKey: "mailtm",
  async createMailboxSession({ request, instance, now }) {
    return {
      id: "mailbox_20260401000000_0001",
      hostId: request.hostId,
      providerTypeKey: "mailtm",
      providerInstanceId: instance.id,
      emailAddress: "demo@mail.tm",
      mailboxRef: "mailtm:demo",
      status: "open",
      createdAt: now.toISOString(),
      metadata: { ...(request.metadata ?? {}) },
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "MAILTM_OK",
      averageLatencyMs: 100,
    };
  },
};

describe("EasyEmailService auth-link support", () => {
  it("derives auth links from manually observed messages", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: [providerInstance],
      adapters: [mailboxAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, new Date("2026-04-01T00:00:00.000Z"));

    service.observeMessage({
      sessionId: opened.session.id,
      sender: "verify@example.com",
      subject: "Verify your email",
      htmlBody: '<a href="https://example.com/verify?token=abc">Verify Account</a>',
      observedAt: "2026-04-01T00:01:00.000Z",
    });

    await expect(service.readAuthenticationLink(opened.session.id)).resolves.toEqual({
      sessionId: opened.session.id,
      providerInstanceId: opened.session.providerInstanceId,
      url: "https://example.com/verify?token=abc",
      label: "Verify Account",
      source: "html",
      observedMessageId: expect.any(String),
      receivedAt: "2026-04-01T00:01:00.000Z",
      links: [
        {
          url: "https://example.com/verify?token=abc",
          label: "Verify Account",
          source: "html",
        },
      ],
    });
  });

  it("returns auth links from provider sync results even when no otp exists", async () => {
    const syncAdapter: MailProviderAdapter = {
      ...mailboxAdapter,
      async syncMailboxCode({ session }) {
        return {
          id: "message_sync_1",
          sessionId: session.id,
          providerInstanceId: session.providerInstanceId,
          observedAt: "2026-04-01T00:02:00.000Z",
          sender: "verify@replit.com",
          subject: "Replit: Verify Your Email",
          htmlBody: '<a href="https://replit.com/action-code?mode=verifyEmail&token=abc">Verify Now</a>',
          textBody: "Click Verify Now to continue.",
        };
      },
    };

    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: [providerInstance],
      adapters: [syncAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, new Date("2026-04-01T00:00:00.000Z"));

    await expect(service.readAuthenticationLink(opened.session.id)).resolves.toEqual({
      sessionId: opened.session.id,
      providerInstanceId: opened.session.providerInstanceId,
      url: "https://replit.com/action-code?mode=verifyEmail&token=abc",
      label: "Verify Now",
      source: "html",
      observedMessageId: "message_sync_1",
      receivedAt: "2026-04-01T00:02:00.000Z",
      links: [
        {
          url: "https://replit.com/action-code?mode=verifyEmail&token=abc",
          label: "Verify Now",
          source: "html",
        },
      ],
    });
  });
});
