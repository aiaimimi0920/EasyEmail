import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { encodeMailTmMailboxRef } from "../../src/providers/mailtm/client.js";
import {
  createCloudflareAdapter,
  createInstance,
  createM2uAdapter,
  createMailTmAdapter,
  createProviderType,
  now,
} from "./mailbox-recoverability-fixtures.js";

describe("mailbox recoverability runtime", () => {
  it("returns temporary credential, provider, and conservative recoverability fields when opening a mailbox", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("mailtm", "Mail.tm")],
      providerInstances: [createInstance("mailtm")],
      adapters: [createMailTmAdapter()],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    expect(opened.createdByProvider).toEqual({
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_shared_default",
      displayName: "mailtm default",
    });
    expect(opened.temporaryAuthCredential).toEqual({
      credentialType: "mailtm_token_password",
      expiresAt: undefined,
      fields: {
        email: "demo@mail.tm",
        token: "mailtm-token-123",
        password: "mailtm-password-123",
      },
      serverManaged: false,
    });
    expect(opened.recoveryDataCredential).toEqual({
      emailAddress: "demo@mail.tm",
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_shared_default",
      hostId: "demo-host",
      email: "demo@mail.tm",
      token: "mailtm-token-123",
      password: "mailtm-password-123",
    });
    expect(opened.recoverabilityLevel).toBe("key_recoverable");
    expect(opened.recoveryRequiredFields).toEqual({
      evidenceStatus: "verified",
      minimumHorizonDays: 90,
      reason: "mailtm_password_relogin_verified",
      fields: {
        emailAddress: "demo@mail.tm",
        password: "mailtm-password-123",
      },
      serverSidePrerequisites: [],
    });
  });

  it("can recover by passing back the opaque recovery data credential returned by open", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("mailtm", "Mail.tm")],
      providerInstances: [createInstance("mailtm")],
      adapters: [createMailTmAdapter()],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    const recovered = await service.recoverMailboxSessionByEmailAddress({
      recoveryDataCredential: opened.recoveryDataCredential,
    }, now);

    expect(recovered.recovered).toBe(true);
    expect(recovered.strategy).toBe("account_restore");
    expect(recovered.providerTypeKey).toBe("mailtm");
    expect(recovered.providerInstanceId).toBe("mailtm_shared_default");
    expect(recovered.session?.emailAddress).toBe("demo@mail.tm");
    expect(recovered.session?.hostId).toBe("demo-host");
    expect(recovered.recoveryDataCredential).toEqual({
      emailAddress: "demo@mail.tm",
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_shared_default",
      hostId: "demo-host",
      email: "demo@mail.tm",
      token: "mailtm-token-restored",
      password: "mailtm-password-123",
    });
  });

  it("excludes undetermined providers from recoverable-only mailbox selection", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("mailtm", "Mail.tm"),
        createProviderType("cloudflare_temp_email", "Cloudflare Temp Email"),
      ],
      providerInstances: [
        createInstance("mailtm"),
        createInstance("cloudflare_temp_email", {
          baseUrl: "https://temp.example.test",
          adminAuth: "server-admin-auth",
        }),
      ],
      adapters: [
        createMailTmAdapter(),
        createCloudflareAdapter(),
      ],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerStrategyModeId: "available-first",
      providerGroupSelections: ["mailtm", "cloudflare_temp_email"],
      preferredInstanceId: "mailtm_shared_default",
      recoverabilityLevels: ["recoverable"],
    }, now);

    expect(opened.instance.providerTypeKey).toBe("cloudflare_temp_email");
    expect(opened.recoverabilityLevel).toBe("recoverable");
    expect(opened.recoveryRequiredFields.evidenceStatus).toBe("verified");
  });

  it("returns equivalent descriptor fields after recovering a persisted mailbox session", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("m2u", "MailToYou")],
      providerInstances: [createInstance("m2u")],
      adapters: [createM2uAdapter()],
    }, now);

    await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    const recovered = await service.recoverMailboxSessionByEmailAddress({
      emailAddress: "restorable@cpu.edu.kg",
      providerTypeKey: "m2u",
      hostId: "demo-host",
    }, now);

    expect(recovered.recovered).toBe(true);
    expect(recovered.createdByProvider).toEqual({
      providerTypeKey: "m2u",
      providerInstanceId: "m2u_shared_default",
      displayName: "m2u default",
    });
    expect(recovered.temporaryAuthCredential).toEqual({
      credentialType: "m2u_token_view_token",
      expiresAt: "2026-06-17T01:00:00.000Z",
      fields: {
        email: "restorable@cpu.edu.kg",
        token: "m2u-token-123",
        viewToken: "m2u-view-456",
        mailboxId: "m2u-mailbox-1",
      },
      serverManaged: false,
    });
    expect(recovered.recoverabilityLevel).toBe("recoverable");
    expect(recovered.recoveryRequiredFields).toEqual({
      evidenceStatus: "verified",
      minimumHorizonDays: 90,
      reason: "manual_same_address_recreation_verified",
      fields: {
        emailAddress: "restorable@cpu.edu.kg",
      },
      serverSidePrerequisites: ["m2u_manual_same_address_recreation"],
    });
  });

  it("can rebuild an m2u mailbox session from caller-saved recovery fields without local state", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("m2u", "MailToYou")],
      providerInstances: [createInstance("m2u")],
      adapters: [createM2uAdapter()],
    }, now);

    const recovered = await service.recoverMailboxSessionByEmailAddress({
      emailAddress: "restorable@cpu.edu.kg",
      providerTypeKey: "m2u",
      hostId: "demo-host",
      recoveryFields: {
        token: "m2u-token-123",
        viewToken: "m2u-view-456",
        mailboxId: "m2u-mailbox-1",
        expiresAt: "2026-06-17T01:00:00.000Z",
      },
    }, now);

    expect(recovered.recovered).toBe(true);
    expect(recovered.strategy).toBe("session_restore");
    expect(recovered.session?.emailAddress).toBe("restorable@cpu.edu.kg");
    expect(recovered.temporaryAuthCredential).toEqual({
      credentialType: "m2u_token_view_token",
      expiresAt: "2026-06-17T01:00:00.000Z",
      fields: {
        email: "restorable@cpu.edu.kg",
        token: "m2u-token-123",
        viewToken: "m2u-view-456",
        mailboxId: "m2u-mailbox-1",
      },
      serverManaged: false,
    });
    expect(recovered.recoverabilityLevel).toBe("recoverable");
    expect(recovered.recoveryRequiredFields).toEqual({
      evidenceStatus: "verified",
      minimumHorizonDays: 90,
      reason: "manual_same_address_recreation_verified",
      fields: {
        emailAddress: "restorable@cpu.edu.kg",
      },
      serverSidePrerequisites: ["m2u_manual_same_address_recreation"],
    });
  });

  it("forwards caller-saved recovery fields to the provider before falling back to generic session rebuild", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("mailtm", "Mail.tm")],
      providerInstances: [createInstance("mailtm")],
      adapters: [createMailTmAdapter()],
    }, now);

    const recovered = await service.recoverMailboxSessionByEmailAddress({
      emailAddress: "demo@mail.tm",
      providerTypeKey: "mailtm",
      hostId: "demo-host",
      recoveryFields: {
        token: "stale-caller-token",
        password: "mailtm-password-123",
      },
    }, now);

    expect(recovered.recovered).toBe(true);
    expect(recovered.strategy).toBe("account_restore");
    expect(recovered.temporaryAuthCredential?.fields).toEqual({
      email: "demo@mail.tm",
      token: "mailtm-token-restored",
      password: "mailtm-password-123",
    });
    expect(recovered.recoveryRequiredFields?.fields).toEqual({
      emailAddress: "demo@mail.tm",
      password: "mailtm-password-123",
    });
  });

  it("routes recovery to the requested provider instance when providerInstanceId is supplied", async () => {
    const attempts: string[] = [];
    const adapter: MailProviderAdapter = {
      typeKey: "mailtm",
      async createMailboxSession() {
        throw new Error("not used");
      },
      async recoverMailboxSession(input) {
        attempts.push(input.instance.id);
        if (input.instance.id !== "mailtm_secondary") {
          return undefined;
        }
        return {
          strategy: "account_restore",
          session: {
            id: "mailbox_mailtm_secondary_restored",
            hostId: input.hostId ?? "recovery:mailtm",
            providerTypeKey: "mailtm",
            providerInstanceId: input.instance.id,
            emailAddress: input.emailAddress,
            mailboxRef: encodeMailTmMailboxRef(input.instance.id, {
              email: input.emailAddress,
              token: "secondary-token",
              password: input.recoveryFields?.password ?? "missing",
            }),
            status: "open",
            createdAt: input.now.toISOString(),
            metadata: {},
          },
          detail: "secondary_instance",
        };
      },
      async probeInstance() {
        return { ok: true, detail: "mailtm_ok", averageLatencyMs: 100 };
      },
    };
    const secondary = createInstance("mailtm");
    secondary.id = "mailtm_secondary";
    secondary.displayName = "mailtm secondary";
    const service = createBootstrappedEasyEmailService({
      providerTypes: [createProviderType("mailtm", "Mail.tm")],
      providerInstances: [
        createInstance("mailtm"),
        secondary,
      ],
      adapters: [adapter],
    }, now);

    const recovered = await service.recoverMailboxSessionByEmailAddress({
      emailAddress: "demo@mail.tm",
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_secondary",
      hostId: "demo-host",
      recoveryFields: {
        password: "mailtm-password-123",
      },
    }, now);

    expect(attempts).toEqual(["mailtm_secondary"]);
    expect(recovered.recovered).toBe(true);
    expect(recovered.providerInstanceId).toBe("mailtm_secondary");
    expect(recovered.createdByProvider).toEqual({
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_secondary",
      displayName: "mailtm secondary",
    });
  });
});
