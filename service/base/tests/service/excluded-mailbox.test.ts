import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import {
  createAdapter,
  createFailingAdapter,
  createInstance,
  createProviderType,
  now,
} from "./excluded-mailbox-fixtures.js";

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

  it("continues past an unavailable fallback provider when opening a mailbox", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("gptmail", "GPT Mail"),
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
      providerStrategyModeId: "available-first",
      providerGroupSelections: ["mailtm", "gptmail", "m2u"],
      preferredInstanceId: "mailtm_shared_default",
      excludedDomains: ["blocked.test"],
    }, now);

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("good@safe.test");
  });

  it("does not let an unavailable final fallback provider mask the last real open failure", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("gptmail", "GPT Mail"),
      ],
      providerInstances: [
        createInstance("mailtm"),
      ],
      adapters: [
        createAdapter("mailtm", "bad@blocked.test"),
      ],
    }, now);

    await expect(service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "gptmail-first",
      providerGroupSelections: ["mailtm", "gptmail"],
      preferredInstanceId: "mailtm_shared_default",
      excludedDomains: ["blocked.test"],
    }, now)).rejects.toMatchObject({
      code: "MAILBOX_DOMAIN_EXCLUDED",
      details: {
        providerTypeKey: "mailtm",
        providerInstanceId: "mailtm_shared_default",
        domain: "blocked.test",
      },
    });
  });

  it("attaches the attempted provider to shared-domain restriction errors", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("im215", "215 Mail"),
      ],
      providerInstances: [
        createInstance("im215"),
      ],
      adapters: [
        createFailingAdapter(
          "im215",
          "215.im createMailbox failed with status 403. This shared domain is currently restricted and not accepting new public addresses",
        ),
      ],
    }, now);

    await expect(service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerTypeKey: "im215",
    }, now)).rejects.toMatchObject({
      code: "MAILBOX_DOMAIN_EXCLUDED",
      details: {
        providerTypeKey: "im215",
        providerInstanceId: "im215_shared_default",
      },
    });
  });

  it("maps request-scoped avoid hints into provider/domain/address exclusions", async () => {
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
      avoid: {
        providerTypeKeys: ["MAILTM" as "mailtm"],
        domains: ["MAIL.TM"],
        emailAddresses: ["Bad@MAIL.TM"],
        reason: "create_account_user_register_400",
        scope: "attempt",
      },
    }, now);

    expect(opened.instance.providerTypeKey).toBe("m2u");
    expect(opened.session.emailAddress).toBe("good@safe.test");
    expect(opened.session.metadata.excludedDomains).toBe("mail.tm");
    expect(opened.session.metadata.excludedEmailAddresses).toBe("bad@mail.tm");
    expect(opened.session.metadata.avoidReason).toBe("create_account_user_register_400");
    expect(opened.session.metadata.avoidScope).toBe("attempt");
  });

  it("preserves structured mailbox outcome attribution metadata", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
      ],
      providerInstances: [
        createInstance("mailtm", { domain: "mail.tm" }),
      ],
      adapters: [
        createAdapter("mailtm", "bad@mail.tm"),
      ],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerTypeKey: "mailtm",
    }, now);

    const result = service.reportMailboxOutcome({
      sessionId: opened.session.id,
      success: false,
      failureReason: "create_account_user_register_400",
      observedAt: "2026-06-04T00:01:00.000Z",
      source: "easyregister",
      businessFlow: "codex-openai-account-v1",
      retryLayer: "step",
      attribution: {
        strength: "weak",
        kind: "mailbox_domain_risk",
        providerTypeKey: "mailtm",
        domain: "mail.tm",
        emailAddress: "bad@mail.tm",
      },
      policy: {
        avoidInCurrentAttempt: true,
        globalBlacklist: false,
        cooldownSeconds: 0,
      },
    }, now);

    expect(result.session.metadata.registrationBusinessFlow).toBe("codex-openai-account-v1");
    expect(result.session.metadata.registrationRetryLayer).toBe("step");
    expect(result.session.metadata.registrationAttributionStrength).toBe("weak");
    expect(result.session.metadata.registrationAttributionKind).toBe("mailbox_domain_risk");
    expect(result.session.metadata.registrationAttributionProviderTypeKey).toBe("mailtm");
    expect(result.session.metadata.registrationAttributionDomain).toBe("mail.tm");
    expect(result.session.metadata.registrationAttributionEmailAddress).toBe("bad@mail.tm");
    expect(result.session.metadata.registrationPolicyAvoidInCurrentAttempt).toBe("true");
    expect(result.session.metadata.registrationPolicyGlobalBlacklist).toBe("false");
    expect(result.session.metadata.registrationPolicyCooldownSeconds).toBe("0");
  });

});
