import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const now = new Date("2026-06-04T00:00:00.000Z");

function createProviderType(key: ProviderTypeDefinition["key"], displayName: string): ProviderTypeDefinition {
  return {
    key,
    displayName,
    description: `${displayName} provider`,
    supportsDynamicProvisioning: false,
    defaultStrategyKey: "dynamic-priority",
    tags: ["external", "free"],
  };
}

function createInstance(
  providerTypeKey: ProviderInstance["providerTypeKey"],
  metadata: Record<string, string> = {},
): ProviderInstance {
  return {
    id: `${providerTypeKey}_shared_default`,
    providerTypeKey,
    displayName: `${providerTypeKey} default`,
    status: "active",
    runtimeKind: "external",
    connectorKind: `${providerTypeKey}-connector`,
    shared: true,
    costTier: "free",
    healthScore: 1,
    averageLatencyMs: 100,
    connectionRef: `external://${providerTypeKey}/default`,
    hostBindings: [],
    groupKeys: [],
    metadata,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function createAdapter(
  typeKey: ProviderTypeDefinition["key"],
  emailAddress: string,
): MailProviderAdapter {
  return {
    typeKey,
    async createMailboxSession({ request, instance, now: openedAt }) {
      return {
        id: `mailbox_${typeKey}`,
        hostId: request.hostId,
        providerTypeKey: typeKey,
        providerInstanceId: instance.id,
        emailAddress,
        mailboxRef: `${typeKey}:test`,
        status: "open",
        createdAt: openedAt.toISOString(),
        metadata: { ...(request.metadata ?? {}) },
      };
    },
    async probeInstance() {
      return {
        ok: true,
        detail: `${typeKey}_ok`,
        averageLatencyMs: 100,
      };
    },
  };
}

describe("mailbox excluded domains and addresses", () => {
  it("filters provider instances whose known domains are excluded before opening", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("m2u", "MailToYou"),
      ],
      providerInstances: [
        createInstance("mailtm", { domain: "mail.tm" }),
        createInstance("m2u", { domain: "safe.test" }),
      ],
      adapters: [
        createAdapter("mailtm", "bad@mail.tm"),
        createAdapter("m2u", "good@safe.test"),
      ],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["mailtm", "m2u"],
      excludedDomains: ["MAIL.TM"],
    }, now);

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("good@safe.test");
    expect(opened.session.metadata.excludedDomains).toBe("mail.tm");
  });

  it("falls back when a provider returns an excluded mailbox domain after open", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("m2u", "MailToYou"),
      ],
      providerInstances: [
        createInstance("mailtm"),
        createInstance("m2u", { domain: "safe.test" }),
      ],
      adapters: [
        createAdapter("mailtm", "bad@blocked.test"),
        createAdapter("m2u", "good@safe.test"),
      ],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["mailtm", "m2u"],
      excludedDomains: ["blocked.test"],
    }, now);

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("good@safe.test");
  });
});
