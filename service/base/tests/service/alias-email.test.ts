import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type {
  MailAliasOutcome,
  MailAliasPlan,
  ProviderInstance,
  ProviderTypeDefinition,
} from "../../src/domain/models.js";
import type { MailAliasService } from "../../src/alias/service.js";

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm",
  description: "Mail.tm external inbox provider.",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["free", "anonymous", "external-api"],
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
  healthScore: 0.98,
  averageLatencyMs: 120,
  connectionRef: "https://api.mail.tm",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const adapter: MailProviderAdapter = {
  typeKey: "mailtm",
  async createMailboxSession({ request, instance, now }) {
    return {
      id: "mailbox_20260401000000_0001",
      hostId: request.hostId,
      providerTypeKey: "mailtm",
      providerInstanceId: instance.id,
      emailAddress: "primary@mail.tm",
      mailboxRef: "mailtm:demo",
      status: "open",
      createdAt: now.toISOString(),
      metadata: { ...(request.metadata ?? {}) },
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "MAILTM_PROBE_OK",
      averageLatencyMs: 120,
    };
  },
};

function createService(aliasService: MailAliasService) {
  return createBootstrappedEasyEmailService({
    providerTypes: [providerType],
    providerInstances: [providerInstance],
    adapters: [adapter],
    aliasService,
  }, new Date("2026-04-01T00:00:00.000Z"));
}

describe("easy email alias integration", () => {
  it("adds aliasPlan to planMailbox responses", () => {
    const aliasPlan: MailAliasPlan = {
      requested: true,
      status: "will_create",
      providerKey: "ddg",
    };

    const service = createService({
      planAlias() {
        return aliasPlan;
      },
      async createAliasOutcome() {
        throw new Error("should not be called");
      },
    });

    const result = service.planMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    });

    expect(result.aliasPlan).toEqual(aliasPlan);
  });

  it("keeps planMailbox available when alias planning throws unexpectedly", () => {
    const service = createService({
      planAlias() {
        throw new Error("alias plan crashed");
      },
      async createAliasOutcome() {
        throw new Error("should not be called");
      },
    });

    const result = service.planMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    });

    expect(result.providerType.key).toBe("mailtm");
    expect(result.aliasPlan).toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "alias_plan_unexpected_error",
      failureMessage: "alias plan crashed",
    });
  });

  it("returns created alias outcome and persists alias metadata on the session", async () => {
    const aliasOutcome: MailAliasOutcome = {
      requested: true,
      status: "created",
      providerKey: "ddg",
      alias: {
        providerKey: "ddg",
        emailAddress: "alpha@duck.com",
        createdAt: "2026-04-01T00:00:00.000Z",
      },
    };

    const service = createService({
      planAlias() {
        return {
          requested: true,
          status: "will_create",
          providerKey: "ddg",
        };
      },
      async createAliasOutcome() {
        return aliasOutcome;
      },
    });

    const result = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
      metadata: {
        purpose: "otp-test",
      },
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.session.emailAddress).toBe("primary@mail.tm");
    expect(result.aliasOutcome).toEqual(aliasOutcome);
    expect(result.session.metadata).toMatchObject({
      purpose: "otp-test",
      aliasRequested: "true",
      aliasStatus: "created",
      aliasProviderKey: "ddg",
      aliasEmailAddress: "alpha@duck.com",
      aliasCreatedAt: "2026-04-01T00:00:00.000Z",
    });

    const savedSession = service.getSnapshot().sessions[0];
    expect(savedSession?.metadata.aliasEmailAddress).toBe("alpha@duck.com");
  });

  it("degrades to a failed alias outcome while keeping the primary mailbox open result", async () => {
    const service = createService({
      planAlias() {
        return {
          requested: true,
          status: "failed",
          providerKey: "ddg",
          failureReason: "ddg_token_missing",
            failureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
        };
      },
      async createAliasOutcome() {
        return {
          requested: true,
          status: "failed",
          providerKey: "ddg",
          failureReason: "ddg_token_missing",
            failureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
        };
      },
    });

    const result = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.session.emailAddress).toBe("primary@mail.tm");
    expect(result.aliasOutcome).toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "ddg_token_missing",
      failureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
    });
    expect(result.session.metadata).toMatchObject({
      aliasRequested: "true",
      aliasStatus: "failed",
      aliasProviderKey: "ddg",
      aliasFailureReason: "ddg_token_missing",
      aliasFailureMessage: "DDG alias provider is enabled but no token is configured in aliasEmail.providers.",
    });
  });

  it("does not convert unexpected alias exceptions into provider fallback or open failure", async () => {
    const service = createService({
      planAlias() {
        throw new Error("alias plan crashed");
      },
      async createAliasOutcome() {
        throw new Error("alias service crashed");
      },
    });

    const result = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      includeAliasEmail: true,
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.session.emailAddress).toBe("primary@mail.tm");
    expect(result.aliasOutcome).toEqual({
      requested: true,
      status: "failed",
      providerKey: "ddg",
      failureReason: "alias_unexpected_error",
      failureMessage: "alias service crashed",
    });
  });
});
