import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm",
  description: "Mail.tm provider",
  supportsDynamicProvisioning: true,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm-default",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm Default",
  status: "active",
  runtimeKind: "external",
  connectorKind: "mailtm-connector",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 100,
  connectionRef: "https://api.mail.tm",
  hostBindings: [],
  groupKeys: [],
  metadata: {
    apiBase: "https://api.mail.tm",
  },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

function createAdapter(observedAt: string): MailProviderAdapter {
  return {
    typeKey: "mailtm",
    async createMailboxSession({ request, instance, now }) {
      return {
        id: "mailbox_20260401000000_0001",
        hostId: request.hostId,
        providerTypeKey: "mailtm",
        providerInstanceId: instance.id,
        emailAddress: "receiver@mail.tm",
        mailboxRef: "mailtm:receiver",
        status: "open",
        createdAt: now.toISOString(),
        metadata: {},
      };
    },
    async syncMailboxCode({ session }) {
      return {
        id: "message_20260401000000_0001",
        sessionId: session.id,
        providerInstanceId: session.providerInstanceId,
        observedAt,
        sender: "sender@example.com",
        subject: "Verification code",
        textBody: "Your verification code is 135790.",
        extractedCode: "135790",
        codeSource: "text",
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
}

describe("mailbox sync freshness tolerance", () => {
  it("accepts provider timestamps that lag mailbox creation by less than the skew allowance", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: [providerInstance],
      adapters: [createAdapter("2026-04-01T00:00:30.000Z")],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, new Date("2026-04-01T00:01:00.000Z"));

    const result = await service.readVerificationCode(opened.session.id);

    expect(result).toMatchObject({
      sessionId: opened.session.id,
      code: "135790",
      source: "text",
    });
  });

  it("still rejects messages that are materially older than mailbox creation", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: [providerInstance],
      adapters: [createAdapter("2026-04-01T00:58:00.000Z")],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, new Date("2026-04-01T01:00:00.000Z"));

    const result = await service.readVerificationCode(opened.session.id);

    expect(result).toBeUndefined();
  });
});
