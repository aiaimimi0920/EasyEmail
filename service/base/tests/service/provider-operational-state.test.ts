import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderCredentialBinding, ProviderCredentialSet, ProviderInstance } from "../../src/domain/models.js";
import { MailRegistry } from "../../src/domain/registry.js";
import { recordMailboxOpenFailure } from "../../src/service/outcomes.js";
import {
  resetProviderOperationalState,
  synchronizeProviderOperationalState,
} from "../../src/service/provider-operational-state.js";
import { clearCredentialRuntimeState, markCredentialCooldownUntilNextResetWindow } from "../../src/shared/credentials.js";

function createProviderInstance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "provider-1",
    providerTypeKey: "gptmail",
    displayName: "GPTMail Default",
    status: "active",
    runtimeKind: "external",
    connectorKind: "gptmail-connector",
    shared: true,
    costTier: "free",
    healthScore: 0.9,
    averageLatencyMs: 200,
    connectionRef: "external://gptmail/default",
    hostBindings: [],
    groupKeys: [],
    metadata: {},
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
    ...overrides,
  };
}

function createCredentialSet(): ProviderCredentialSet {
  return {
    id: "cred-set-1",
    providerTypeKey: "gptmail",
    displayName: "GPT Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    groupKeys: [],
    items: [
      { id: "key-a", label: "Key A", value: "key-a", metadata: {} },
      { id: "key-b", label: "Key B", value: "key-b", metadata: {} },
    ],
    metadata: {},
    createdAt: "2026-04-04T00:00:00.000Z",
    updatedAt: "2026-04-04T00:00:00.000Z",
  };
}

function createCredentialBinding(providerInstanceId: string, credentialSetId: string): ProviderCredentialBinding {
  return {
    providerInstanceId,
    credentialSetId,
    priority: 100,
    updatedAt: "2026-04-04T00:00:00.000Z",
  };
}

describe("provider operational cooling", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.useRealTimers();
  });

  it("marks api-key providers as cooling when every key is cooled until the reset window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T01:00:00.000Z"));

    const instance = createProviderInstance();
    const credentialSet = createCredentialSet();
    const registry = new MailRegistry({
      instances: [instance],
      credentialSets: [credentialSet],
      credentialBindings: [createCredentialBinding(instance.id, credentialSet.id)],
    });

    markCredentialCooldownUntilNextResetWindow(`mail:${instance.providerTypeKey}:${instance.id}`, credentialSet, credentialSet.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    });
    markCredentialCooldownUntilNextResetWindow(`mail:${instance.providerTypeKey}:${instance.id}`, credentialSet, credentialSet.items[1]!, {
      status: "cooling",
      error: "quota exhausted",
      now: new Date(),
    });

    synchronizeProviderOperationalState(registry, new Date());

    expect(registry.findInstanceById(instance.id)?.status).toBe("cooling");

    vi.setSystemTime(new Date("2026-04-04T06:00:00.000Z"));
    synchronizeProviderOperationalState(registry, new Date());

    expect(registry.findInstanceById(instance.id)?.status).toBe("active");
    expect(registry.findInstanceById(instance.id)?.metadata.operationalCooldownUntil).toBeUndefined();
  });

  it("requires three consecutive capacity failures before cooling keyless providers", () => {
    const instance = createProviderInstance({
      id: "mailtm-default",
      providerTypeKey: "mailtm",
      displayName: "Mail.tm Default",
      connectorKind: "mailtm-connector",
      metadata: {
        apiBase: "https://api.mail.tm",
      },
    });
    const registry = new MailRegistry({
      instances: [instance],
    });

    recordMailboxOpenFailure(
      registry,
      registry.findInstanceById(instance.id) ?? instance,
      new Error("Mail.tm createMailbox failed with status 429."),
      new Date("2026-04-04T02:00:00.000Z"),
    );
    expect(registry.findInstanceById(instance.id)?.status).toBe("degraded");
    expect(registry.findInstanceById(instance.id)?.metadata.operationalCooldownUntil).toBeUndefined();

    recordMailboxOpenFailure(
      registry,
      registry.findInstanceById(instance.id) ?? instance,
      new Error("Mail.tm createMailbox failed with status 429."),
      new Date("2026-04-04T02:01:00.000Z"),
    );
    expect(registry.findInstanceById(instance.id)?.status).toBe("degraded");
    expect(registry.findInstanceById(instance.id)?.metadata.operationalCooldownUntil).toBeUndefined();

    recordMailboxOpenFailure(
      registry,
      registry.findInstanceById(instance.id) ?? instance,
      new Error("Mail.tm createMailbox failed with status 429."),
      new Date("2026-04-04T02:02:00.000Z"),
    );
    expect(registry.findInstanceById(instance.id)?.status).toBe("cooling");

    resetProviderOperationalState(registry, new Date("2026-04-04T02:05:00.000Z"));

    expect(registry.findInstanceById(instance.id)?.status).toBe("active");
    expect(registry.findInstanceById(instance.id)?.metadata.operationalCooldownUntil).toBeUndefined();
  });

  it("clears pending provider cooling streaks on boot reset", () => {
    const instance = createProviderInstance({
      id: "guerrillamail-default",
      providerTypeKey: "guerrillamail",
      displayName: "GuerrillaMail Default",
      connectorKind: "guerrillamail-connector",
      metadata: {
        apiBase: "https://api.guerrillamail.com",
      },
    });
    const registry = new MailRegistry({
      instances: [instance],
    });

    recordMailboxOpenFailure(
      registry,
      registry.findInstanceById(instance.id) ?? instance,
      new Error("GuerrillaMail createMailbox failed with status 429."),
      new Date("2026-04-04T03:00:00.000Z"),
    );

    expect(registry.findInstanceById(instance.id)?.metadata.operationalCriticalFailureCount).toBe("1");

    resetProviderOperationalState(registry, new Date("2026-04-04T03:05:00.000Z"));

    expect(registry.findInstanceById(instance.id)?.metadata.operationalCriticalFailureCount).toBeUndefined();
  });
});
