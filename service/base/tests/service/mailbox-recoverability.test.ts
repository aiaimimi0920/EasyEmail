import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { encodeCloudflareTempMailboxRef } from "../../src/providers/cloudflare_temp_email/connector/client.js";
import { encodeM2uMailboxRef } from "../../src/providers/m2u/client.js";
import { encodeMailTmMailboxRef } from "../../src/providers/mailtm/client.js";

const now = new Date("2026-06-17T00:00:00.000Z");

function createProviderType(key: ProviderTypeDefinition["key"], displayName: string): ProviderTypeDefinition {
  return {
    key,
    displayName,
    description: `${displayName} provider`,
    supportsDynamicProvisioning: false,
    defaultStrategyKey: "dynamic-priority",
    tags: ["external"],
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
    runtimeKind: providerTypeKey === "cloudflare_temp_email" ? "cloudflare_temp_email-runtime" : "external",
    connectorKind: `${providerTypeKey}-connector`,
    shared: true,
    costTier: providerTypeKey === "cloudflare_temp_email" ? "paid" : "free",
    healthScore: 1,
    averageLatencyMs: 100,
    connectionRef: providerTypeKey === "cloudflare_temp_email"
      ? "https://temp.example.test"
      : `external://${providerTypeKey}/default`,
    hostBindings: [],
    groupKeys: [],
    metadata,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function createMailTmAdapter(): MailProviderAdapter {
  return {
    typeKey: "mailtm",
    async createMailboxSession({ request, instance, now: openedAt }) {
      const mailbox = {
        email: "demo@mail.tm",
        token: "mailtm-token-123",
        password: "mailtm-password-123",
      };
      return {
        id: "mailbox_mailtm",
        hostId: request.hostId,
        providerTypeKey: "mailtm",
        providerInstanceId: instance.id,
        emailAddress: mailbox.email,
        mailboxRef: encodeMailTmMailboxRef(instance.id, mailbox),
        status: "open",
        createdAt: openedAt.toISOString(),
        metadata: { ...(request.metadata ?? {}) },
      };
    },
    async probeInstance() {
      return { ok: true, detail: "mailtm_ok", averageLatencyMs: 100 };
    },
    async recoverMailboxSession(input) {
      const recoveryFields = (input as typeof input & { recoveryFields?: Record<string, string> }).recoveryFields;
      if (recoveryFields?.password !== "mailtm-password-123") {
        return undefined;
      }
      const mailbox = {
        email: input.emailAddress,
        token: "mailtm-token-restored",
        password: recoveryFields.password,
      };
      return {
        strategy: "account_restore",
        session: {
          id: "mailbox_mailtm_restored",
          hostId: input.hostId ?? "recovery:mailtm",
          providerTypeKey: "mailtm",
          providerInstanceId: input.instance.id,
          emailAddress: mailbox.email,
          mailboxRef: encodeMailTmMailboxRef(input.instance.id, mailbox),
          status: "open",
          createdAt: input.now.toISOString(),
          metadata: {
            recoveredFromEmailAddress: mailbox.email,
            recoveryStrategy: "account_restore",
            recoverySource: "provider_password_relogin",
          },
        },
        detail: "password_relogin",
      };
    },
  };
}

function createM2uAdapter(): MailProviderAdapter {
  return {
    typeKey: "m2u",
    async createMailboxSession({ request, instance, now: openedAt }) {
      const mailbox = {
        email: "restorable@cpu.edu.kg",
        token: "m2u-token-123",
        viewToken: "m2u-view-456",
        mailboxId: "m2u-mailbox-1",
        expiresAt: "2026-06-17T01:00:00.000Z",
      };
      return {
        id: "mailbox_m2u",
        hostId: request.hostId,
        providerTypeKey: "m2u",
        providerInstanceId: instance.id,
        emailAddress: mailbox.email,
        mailboxRef: encodeM2uMailboxRef(instance.id, mailbox),
        status: "open",
        createdAt: openedAt.toISOString(),
        expiresAt: mailbox.expiresAt,
        metadata: { ...(request.metadata ?? {}) },
      };
    },
    async probeInstance() {
      return { ok: true, detail: "m2u_ok", averageLatencyMs: 100 };
    },
  };
}

function createCloudflareAdapter(): MailProviderAdapter {
  return {
    typeKey: "cloudflare_temp_email",
    async createMailboxSession({ request, instance, now: openedAt }) {
      const mailbox = {
        address: "demo@pool.example.test",
        jwt: "cloudflare-jwt-123",
      };
      return {
        id: "mailbox_cloudflare",
        hostId: request.hostId,
        providerTypeKey: "cloudflare_temp_email",
        providerInstanceId: instance.id,
        emailAddress: mailbox.address,
        mailboxRef: encodeCloudflareTempMailboxRef(instance.id, mailbox),
        status: "open",
        createdAt: openedAt.toISOString(),
        metadata: { ...(request.metadata ?? {}) },
      };
    },
    async probeInstance() {
      return { ok: true, detail: "cloudflare_ok", averageLatencyMs: 100 };
    },
  };
}

describe("mailbox recoverability descriptors", () => {
  it("exposes provider recoverability profiles through catalog and mailbox plan", () => {
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

    const catalog = service.getCatalog();

    expect(catalog.providerRecoverabilityProfiles).toEqual([
      {
        providerTypeKey: "mailtm",
        providerInstanceId: "mailtm_shared_default",
        recoverabilityLevel: "key_recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: "mailtm_password_relogin_verified",
      },
      {
        providerTypeKey: "cloudflare_temp_email",
        providerInstanceId: "cloudflare_temp_email_shared_default",
        recoverabilityLevel: "recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: "operator_controlled_mailbox_store",
      },
    ]);

    const plan = service.planMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);

    expect(plan.recoverabilityProfile).toEqual({
      providerTypeKey: "mailtm",
      providerInstanceId: "mailtm_shared_default",
      recoverabilityLevel: "key_recoverable",
      evidenceStatus: "verified",
      minimumHorizonDays: 90,
      reason: "mailtm_password_relogin_verified",
    });
  });

  it("marks user-verified same-address providers as recoverable by default", () => {
    const providerKeys: ProviderInstance["providerTypeKey"][] = [
      "cloudflare_temp_email",
      "im215",
      "mail2925",
      "gptmail",
      "moemail",
      "m2u",
    ];
    const service = createBootstrappedEasyEmailService({
      providerTypes: providerKeys.map((key) => createProviderType(key, key)),
      providerInstances: providerKeys.map((key) => createInstance(key)),
      adapters: [],
    }, now);

    expect(service.getCatalog().providerRecoverabilityProfiles).toEqual(
      expect.arrayContaining(providerKeys.map((key) => ({
        providerTypeKey: key,
        providerInstanceId: `${key}_shared_default`,
        recoverabilityLevel: "recoverable",
        evidenceStatus: "verified",
        minimumHorizonDays: 90,
        reason: key === "cloudflare_temp_email"
          ? "operator_controlled_mailbox_store"
          : key === "m2u"
            ? "manual_same_address_recreation_verified"
            : "same_address_recreation_verified",
      }))),
    );
  });

  it("marks live-probed remaining providers with evidence-backed recoverability levels", () => {
    const expected: Array<{
      key: ProviderInstance["providerTypeKey"];
      level: "unrecoverable" | "key_recoverable" | "recoverable";
      evidenceStatus: "undetermined" | "verified";
      reason: string;
    }> = [
      {
        key: "mailtm",
        level: "key_recoverable",
        evidenceStatus: "verified",
        reason: "mailtm_password_relogin_verified",
      },
      {
        key: "temporam",
        level: "recoverable",
        evidenceStatus: "verified",
        reason: "temporam_same_address_stateless_inbox_verified",
      },
      {
        key: "guerrillamail",
        level: "recoverable",
        evidenceStatus: "verified",
        reason: "guerrillamail_same_user_recreation_verified",
      },
      {
        key: "duckmail",
        level: "key_recoverable",
        evidenceStatus: "verified",
        reason: "duckmail_password_relogin_verified",
      },
      {
        key: "tempmail-lol",
        level: "unrecoverable",
        evidenceStatus: "verified",
        reason: "tempmail_lol_historical_token_future_delivery_failed",
      },
      {
        key: "etempmail",
        level: "unrecoverable",
        evidenceStatus: "verified",
        reason: "etempmail_recover_key_invalid_in_live_probe",
      },
    ];

    const service = createBootstrappedEasyEmailService({
      providerTypes: expected.map((item) => createProviderType(item.key, item.key)),
      providerInstances: expected.map((item) => createInstance(item.key)),
      adapters: [],
    }, now);

    expect(service.getCatalog().providerRecoverabilityProfiles).toEqual(
      expect.arrayContaining(expected.map((item) => ({
        providerTypeKey: item.key,
        providerInstanceId: `${item.key}_shared_default`,
        recoverabilityLevel: item.level,
        evidenceStatus: item.evidenceStatus,
        minimumHorizonDays: 90,
        reason: item.reason,
      }))),
    );
  });

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
