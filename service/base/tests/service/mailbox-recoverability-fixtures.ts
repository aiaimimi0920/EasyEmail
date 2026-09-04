import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { encodeCloudflareTempMailboxRef } from "../../src/providers/cloudflare_temp_email/connector/client.js";
import { encodeM2uMailboxRef } from "../../src/providers/m2u/client.js";
import { encodeMailTmMailboxRef } from "../../src/providers/mailtm/client.js";

export const now = new Date("2026-06-17T00:00:00.000Z");

export function createProviderType(
  key: ProviderTypeDefinition["key"],
  displayName: string,
): ProviderTypeDefinition {
  return {
    key,
    displayName,
    description: `${displayName} provider`,
    supportsDynamicProvisioning: false,
    defaultStrategyKey: "dynamic-priority",
    tags: ["external"],
  };
}

export function createInstance(
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

export function createMailTmAdapter(): MailProviderAdapter {
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

export function createM2uAdapter(): MailProviderAdapter {
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

export function createCloudflareAdapter(): MailProviderAdapter {
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
