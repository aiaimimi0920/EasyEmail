import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";

export const now = new Date("2026-06-04T00:00:00.000Z");

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
    tags: ["external", "free"],
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

export function createAdapter(
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

export function createSequentialAdapter(
  typeKey: ProviderTypeDefinition["key"],
  emailAddresses: string[],
): MailProviderAdapter {
  let index = 0;
  return {
    typeKey,
    async createMailboxSession({ request, instance, now: openedAt }) {
      const emailAddress = emailAddresses[Math.min(index, emailAddresses.length - 1)] ?? emailAddresses[0]!;
      index += 1;
      return {
        id: `mailbox_${typeKey}_${index}`,
        hostId: request.hostId,
        providerTypeKey: typeKey,
        providerInstanceId: instance.id,
        emailAddress,
        mailboxRef: `${typeKey}:test:${index}`,
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

export function createFailingAdapter(
  typeKey: ProviderTypeDefinition["key"],
  message: string,
): MailProviderAdapter {
  return {
    typeKey,
    async createMailboxSession() {
      throw new Error(message);
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
