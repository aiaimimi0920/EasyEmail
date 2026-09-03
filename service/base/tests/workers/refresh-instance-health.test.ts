import { describe, expect, it } from "vitest";
import type { MailboxSession, ProviderInstance } from "../../src/domain/models.js";
import { MailRegistry } from "../../src/domain/registry.js";
import { refreshInstanceHealth } from "../../src/workers/refresh-instance-health.js";

const NOW = new Date("2026-08-26T00:00:00.000Z");

function createProviderInstance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "temporam_shared_default",
    providerTypeKey: "temporam",
    displayName: "Temporam",
    status: "active",
    runtimeKind: "external",
    connectorKind: "temporam-connector",
    shared: true,
    costTier: "free",
    healthScore: 0.85,
    averageLatencyMs: 900,
    connectionRef: "external://temporam/default",
    hostBindings: [],
    groupKeys: [],
    metadata: {},
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
    ...overrides,
  };
}

function createSession(status: MailboxSession["status"], createdAt: string): MailboxSession {
  return {
    id: `session-${status}-${createdAt}`,
    hostId: "test-host",
    providerTypeKey: "temporam",
    providerInstanceId: "temporam_shared_default",
    emailAddress: "test@example.invalid",
    mailboxRef: "mailbox-ref",
    status,
    createdAt,
    metadata: {},
  };
}

function createReleasedSession(createdAt: string): MailboxSession {
  return {
    ...createSession("expired", createdAt),
    metadata: {
      releasedAt: NOW.toISOString(),
      releaseReason: "dst_flow_cleanup",
      releaseStatus: "skipped",
    },
  };
}

describe("refreshInstanceHealth", () => {
  it("does not let historical expired sessions keep a freshly probed instance degraded", () => {
    const instance = createProviderInstance();
    const registry = new MailRegistry({
      instances: [instance],
      sessions: [createSession("expired", "2026-08-20T00:00:00.000Z")],
    });

    expect(refreshInstanceHealth(registry, NOW)).toEqual([]);
    expect(registry.findInstanceById(instance.id)).toMatchObject({
      status: "active",
      healthScore: 0.85,
    });
  });

  it("keeps open sessions out of the health calculation until they have an outcome", () => {
    const instance = createProviderInstance();
    const registry = new MailRegistry({
      instances: [instance],
      sessions: [createSession("open", "2026-08-25T23:59:00.000Z")],
    });

    expect(refreshInstanceHealth(registry, NOW)).toEqual([]);
    expect(registry.findInstanceById(instance.id)?.healthScore).toBe(0.85);
  });

  it("does not penalize an explicitly released session when a provider has no release endpoint", () => {
    const instance = createProviderInstance();
    const registry = new MailRegistry({
      instances: [instance],
      sessions: [createReleasedSession("2026-08-25T23:59:00.000Z")],
    });

    expect(refreshInstanceHealth(registry, NOW)).toEqual([]);
    expect(registry.findInstanceById(instance.id)?.healthScore).toBe(0.85);
  });

  it("still applies the penalty for recent expired sessions", () => {
    const instance = createProviderInstance();
    const registry = new MailRegistry({
      instances: [instance],
      sessions: [createSession("expired", "2026-08-25T23:59:00.000Z")],
    });

    expect(refreshInstanceHealth(registry, NOW)).toEqual([{
      instanceId: instance.id,
      previousHealthScore: 0.85,
      nextHealthScore: 0.1,
    }]);
    expect(registry.findInstanceById(instance.id)).toMatchObject({
      status: "degraded",
      healthScore: 0.1,
    });
  });
});
