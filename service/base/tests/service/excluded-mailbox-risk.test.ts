import { afterEach, describe, expect, it, vi } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import {
  createAdapter,
  createInstance,
  createProviderType,
  createSequentialAdapter,
  now,
} from "./excluded-mailbox-fixtures.js";

describe("mailbox outcome risk routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps a provider eligible after strong mailbox-domain risk when it can avoid the bad domain", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
        createProviderType("moemail", "MoEmail"),
      ],
      providerInstances: [
        createInstance("m2u", { domainsCsv: "blocked.test,safe.test" }),
        createInstance("moemail", { domain: "fallback.test" }),
      ],
      adapters: [
        createSequentialAdapter("m2u", ["bad@blocked.test", "good@safe.test"]),
        createAdapter("moemail", "fallback@fallback.test"),
      ],
    }, now);

    const first = await service.openMailbox({
      hostId: "demo-host-1",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    service.reportMailboxOutcome({
      sessionId: first.session.id,
      success: false,
      failureReason: "unsupported_email",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "strong",
        kind: "mailbox_domain_risk",
        providerTypeKey: "m2u",
        domain: "blocked.test",
        emailAddress: "bad@blocked.test",
      },
      policy: {
        avoidInCurrentAttempt: true,
        // Legacy callers may have sent this too broadly for unsupported_email.
        // Domain-risk metadata must not hide the whole provider when another
        // supported domain can still be selected.
        globalBlacklist: true,
        cooldownSeconds: 0,
      },
    }, new Date("2026-06-04T00:01:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host-2",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["m2u", "moemail"],
      excludedDomains: ["blocked.test"],
    }, new Date("2026-06-04T00:20:00.000Z"));

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("good@safe.test");
    expect(opened.strategyMode?.providerGroupOrder).toContain("m2u");
  });

  it("records mailbox-domain risk without degrading provider route health", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
      ],
      providerInstances: [
        createInstance("m2u", { domainsCsv: "blocked.test,safe.test" }),
      ],
      adapters: [
        createAdapter("m2u", "bad@blocked.test"),
      ],
    }, now);

    const first = await service.openMailbox({
      hostId: "demo-host-1",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    const result = service.reportMailboxOutcome({
      sessionId: first.session.id,
      success: false,
      failureReason: "unsupported_email",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "strong",
        kind: "mailbox_domain_risk",
        providerTypeKey: "m2u",
        domain: "blocked.test",
        emailAddress: "bad@blocked.test",
      },
      policy: {
        avoidInCurrentAttempt: true,
        globalBlacklist: false,
        cooldownSeconds: 0,
      },
    }, new Date("2026-06-04T00:01:00.000Z"));

    expect(result.instance.status).toBe("active");
    expect(result.instance.healthScore).toBe(1);
    expect(result.instance.metadata.consecutiveFailureCount).toBeUndefined();
    expect(result.instance.metadata.cooldownUntil).toBeUndefined();
    expect(result.instance.metadata.lastFailureClass).toBeUndefined();
    expect(result.instance.metadata.lastRegistrationOutcome).toBeUndefined();
    expect(result.instance.metadata.lastRegistrationAttributionKind).toBeUndefined();
    const stats = JSON.parse(result.instance.metadata.registrationStatsJson ?? "{}") as {
      failureCount?: number;
      domains?: Record<string, { failureCount?: number }>;
    };
    expect(stats.failureCount).toBe(0);
    expect(stats.domains?.["blocked.test"]?.failureCount).toBe(1);
  });

  it("does not let legacy mailbox-domain risk state trip provider health gates", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
        createProviderType("moemail", "MoEmail"),
      ],
      providerInstances: [
        {
          ...createInstance("m2u", {
            domain: "safe.test",
            lastRegistrationOutcome: "failure",
            lastRegistrationOutcomeAt: "2026-06-04T00:01:00.000Z",
            lastRegistrationFailureReason: "unsupported_email",
            lastRegistrationAttributionKind: "mailbox_domain_risk",
            lastRegistrationAttributionStrength: "strong",
            lastRegistrationPolicyGlobalBlacklist: "true",
            consecutiveFailureCount: "1",
            cooldownUntil: "2026-06-04T00:06:00.000Z",
            registrationStatsJson: JSON.stringify({
              successCount: 0,
              failureCount: 1,
              lastFailureAt: "2026-06-04T00:01:00.000Z",
              domains: {
                "blocked.test": {
                  successCount: 0,
                  failureCount: 1,
                  lastFailureAt: "2026-06-04T00:01:00.000Z",
                },
              },
            }),
          }),
          status: "degraded",
          healthScore: 0.656,
        },
        {
          ...createInstance("moemail", {
            domain: "fallback.test",
          }),
          healthScore: 0.76,
        },
      ],
      routingProfiles: [
        {
          id: "strict-route-health",
          displayName: "Strict Route Health",
          description: "Reject provider routes with recent provider failures.",
          providerStrategyModeId: "available-first",
          providerSelections: ["m2u", "moemail"],
          healthGate: {
            minimumHealthScore: 0.7,
            maxConsecutiveFailures: 0,
          },
        },
      ],
    }, now);

    const plan = service.planMailbox({
      hostId: "demo-host-legacy-domain-risk",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerRoutingProfileId: "strict-route-health",
    }, new Date("2026-06-04T00:02:00.000Z"));

    expect(plan.instance.providerTypeKey).toBe("m2u");
    expect(plan.strategyMode?.providerGroupOrder).toContain("m2u");
  });

  it("keeps weak mailbox-domain outcomes advisory unless the request excludes the domain", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
        createProviderType("mailtm", "Mail.tm"),
      ],
      providerInstances: [
        createInstance("m2u", { domain: "risk.test" }),
        createInstance("mailtm", { domain: "mail.tm" }),
      ],
      adapters: [
        createAdapter("m2u", "bad@risk.test"),
        createAdapter("mailtm", "good@mail.tm"),
      ],
    }, now);

    const first = await service.openMailbox({
      hostId: "demo-host-1",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    service.reportMailboxOutcome({
      sessionId: first.session.id,
      success: false,
      failureReason: "create_account_user_register_400",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "weak",
        kind: "mailbox_domain_risk",
        providerTypeKey: "m2u",
        domain: "risk.test",
        emailAddress: "bad@risk.test",
      },
      policy: {
        avoidInCurrentAttempt: true,
        globalBlacklist: false,
        cooldownSeconds: 600,
      },
    }, new Date("2026-06-04T00:01:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host-2",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "available-first",
      providerGroupSelections: ["m2u", "mailtm"],
    }, new Date("2026-06-04T00:02:00.000Z"));

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("bad@risk.test");
    expect(opened.strategyMode?.providerGroupOrder).toContain("m2u");
  });

  it("skips a strong provider-route blacklist on later automatic selection", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
        createProviderType("moemail", "MoEmail"),
      ],
      providerInstances: [
        createInstance("m2u", { domain: "safe.test" }),
        createInstance("moemail", { domain: "fallback.test" }),
      ],
      adapters: [
        createAdapter("m2u", "m2u@safe.test"),
        createAdapter("moemail", "fallback@fallback.test"),
      ],
    }, now);

    const first = await service.openMailbox({
      hostId: "demo-host-1",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    service.reportMailboxOutcome({
      sessionId: first.session.id,
      success: false,
      failureReason: "provider_auth_failed",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "strong",
        kind: "provider_route",
        providerTypeKey: "m2u",
      },
      policy: {
        avoidInCurrentAttempt: true,
        globalBlacklist: true,
        cooldownSeconds: 0,
      },
    }, new Date("2026-06-04T00:01:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host-2",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["m2u", "moemail"],
    }, new Date("2026-06-04T00:20:00.000Z"));

    expect(opened.instance.providerTypeKey).toBe("moemail");
    expect(opened.session.emailAddress).toBe("fallback@fallback.test");
    expect(opened.strategyMode?.providerGroupOrder).not.toContain("m2u");
  });

  it("does not reintroduce a structured provider-route blacklist during open fallback", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("m2u", "MailToYou"),
        createProviderType("moemail", "MoEmail"),
      ],
      providerInstances: [
        createInstance("mailtm", { domain: "mail.tm" }),
        createInstance("m2u"),
        createInstance("moemail", { domain: "safe.test" }),
      ],
      adapters: [
        createAdapter("mailtm", "blacklisted@mail.tm"),
        createAdapter("m2u", "blocked@blocked.test"),
        createAdapter("moemail", "good@safe.test"),
      ],
    }, now);

    const blacklisted = await service.openMailbox({
      hostId: "demo-host-1",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    service.reportMailboxOutcome({
      sessionId: blacklisted.session.id,
      success: false,
      failureReason: "unsupported_email",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "strong",
        kind: "provider_route",
        providerTypeKey: "mailtm",
      },
      policy: {
        avoidInCurrentAttempt: true,
        globalBlacklist: true,
        cooldownSeconds: 0,
      },
    }, new Date("2026-06-04T00:01:00.000Z"));

    const opened = await service.openMailbox({
      hostId: "demo-host-2",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["mailtm", "m2u", "moemail"],
      excludedDomains: ["blocked.test"],
    }, new Date("2026-06-04T00:20:00.000Z"));

    expect(opened.instance.providerTypeKey).toBe("moemail");
    expect(opened.session.emailAddress).toBe("good@safe.test");
  });
});
