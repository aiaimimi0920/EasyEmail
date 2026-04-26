import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const m2uProviderType: ProviderTypeDefinition = {
  key: "m2u",
  displayName: "MailToYou",
  description: "MailToYou provider",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "free-first",
  tags: ["external", "free"],
};

const m2uInstance: ProviderInstance = {
  id: "m2u_shared_default",
  providerTypeKey: "m2u",
  displayName: "MailToYou Default",
  status: "active",
  runtimeKind: "external",
  connectorKind: "m2u-api",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 100,
  connectionRef: "https://api.m2u.io",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const m2uAdapter: MailProviderAdapter = {
  typeKey: "m2u",
  async createMailboxSession({ request, instance, now }) {
    return {
      id: "mailbox_20260401000000_0001",
      hostId: request.hostId,
      providerTypeKey: "m2u",
      providerInstanceId: instance.id,
      emailAddress: `${request.requestedLocalPart ?? "auto"}@${request.requestedDomain ?? "cpu.edu.kg"}`,
      mailboxRef: "m2u:test",
      status: "open",
      createdAt: now.toISOString(),
      metadata: {
        ...(request.metadata ?? {}),
        requestedLocalPartSeenByAdapter: request.requestedLocalPart ?? "",
        requestedDomainSeenByAdapter: request.requestedDomain ?? "",
        turnstileTokenSeenByAdapter: request.turnstileToken ? "true" : "false",
      },
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "M2U_OK",
      averageLatencyMs: 100,
    };
  },
};

describe("easy email m2u custom mailbox request normalization", () => {
  it("preserves explicit requestedLocalPart and strips turnstile token from persisted metadata", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [m2uProviderType],
      providerInstances: [m2uInstance],
      adapters: [m2uAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const result = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      requestedDomain: "shaole.me",
      requestedLocalPart: "customprefix",
      turnstileToken: "cf-token-123",
      metadata: {
        source: "unit-test",
      },
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.session.emailAddress).toBe("customprefix@shaole.me");
    expect(result.session.metadata).toMatchObject({
      source: "unit-test",
      requestedLocalPart: "customprefix",
      requestedLocalPartSeenByAdapter: "customprefix",
      requestedDomainSeenByAdapter: "shaole.me",
      turnstileTokenSeenByAdapter: "true",
    });
    expect(result.session.metadata.turnstileToken).toBeUndefined();
    expect(result.session.metadata.cfTurnstileResponse).toBeUndefined();
    expect(result.session.metadata["cf-turnstile-response"]).toBeUndefined();
  });

  it("accepts legacy metadata aliases for localPart and Turnstile response", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [m2uProviderType],
      providerInstances: [m2uInstance],
      adapters: [m2uAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const result = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      requestedDomain: "tmail.bio",
      metadata: {
        prefix: "legacy-prefix",
        "cf-turnstile-response": "legacy-turnstile-token",
        source: "legacy-alias",
      },
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.session.emailAddress).toBe("legacy-prefix@tmail.bio");
    expect(result.session.metadata).toMatchObject({
      source: "legacy-alias",
      requestedLocalPart: "legacy-prefix",
      requestedLocalPartSeenByAdapter: "legacy-prefix",
      requestedDomainSeenByAdapter: "tmail.bio",
      turnstileTokenSeenByAdapter: "true",
    });
    expect(result.session.metadata.prefix).toBeUndefined();
    expect(result.session.metadata["cf-turnstile-response"]).toBeUndefined();
  });
});
