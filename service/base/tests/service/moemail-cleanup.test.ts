import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderInstance,
} from "../../src/domain/models.js";
import { EasyEmailError } from "../../src/domain/errors.js";
import { MailRegistry } from "../../src/domain/registry.js";
import { EasyEmailService } from "../../src/service/easy-email-service.js";
import { clearCredentialRuntimeState } from "../../src/shared/index.js";

function createFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function createProviderInstance(overrides: Partial<ProviderInstance> = {}): ProviderInstance {
  return {
    id: "moemail-default",
    providerTypeKey: "moemail",
    displayName: "MoEmail Default",
    status: "active",
    runtimeKind: "external",
    connectorKind: "moemail-connector",
    shared: true,
    costTier: "free",
    healthScore: 0.9,
    averageLatencyMs: 200,
    connectionRef: "https://moemail.app",
    hostBindings: [],
    groupKeys: [],
    metadata: {
      apiBase: "https://moemail.app",
      expiryTimeMs: "1800000",
    },
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
    ...overrides,
  };
}

function createCredentialSet(id = "cred-set-1"): ProviderCredentialSet {
  return {
    id,
    providerTypeKey: "moemail",
    displayName: "MoEmail Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    groupKeys: [],
    items: [
      {
        id: `${id}-item-1`,
        label: "Key A",
        value: "test-api-key",
        metadata: {},
      },
    ],
    metadata: {},
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
  };
}

function createCredentialBinding(providerInstanceId: string, credentialSetId: string): ProviderCredentialBinding {
  return {
    providerInstanceId,
    credentialSetId,
    priority: 100,
    updatedAt: "2026-04-24T00:00:00.000Z",
  };
}

function createService(instances: ProviderInstance[]): EasyEmailService {
  const credentialSets = instances.map((instance, index) => createCredentialSet(`cred-set-${index + 1}`));
  const credentialBindings = instances.map((instance, index) => (
    createCredentialBinding(instance.id, credentialSets[index]!.id)
  ));

  return new EasyEmailService(
    new MailRegistry({
      instances,
      credentialSets,
      credentialBindings,
    }),
  );
}

describe("EasyEmailService.cleanupMoemailMailboxes", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the configured MoEmail expiry window when only expiresAt is available", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createFetchResponse(200, {
      emails: [
        {
          id: "email-123",
          address: "demo@moemail.app",
          expiresAt: "2026-04-24T12:29:00.000Z",
        },
      ],
    }));
    vi.stubGlobal("fetch", fetchMock);

    const service = createService([
      createProviderInstance({
        metadata: {
          apiBase: "https://moemail.app",
          expiryTimeMs: "1800000",
        },
      }),
    ]);

    const result = await service.cleanupMoemailMailboxes(300, 10, false, undefined, new Date("2026-04-24T12:00:00.000Z"));

    expect(result.deletedCount).toBe(0);
    expect(result.skippedCount).toBe(1);
    expect(result.skipped).toContainEqual({
      emailId: "email-123",
      email: "demo@moemail.app",
      reason: "remaining_lifetime_too_high",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("requires providerInstanceId when multiple MoEmail instances are registered", async () => {
    const service = createService([
      createProviderInstance({
        id: "moemail-a",
        metadata: {
          apiBase: "https://moemail-a.example",
          expiryTimeMs: "1800000",
        },
      }),
      createProviderInstance({
        id: "moemail-b",
        metadata: {
          apiBase: "https://moemail-b.example",
          expiryTimeMs: "1800000",
        },
      }),
    ]);

    await expect(service.cleanupMoemailMailboxes(300, 10, false)).rejects.toMatchObject({
      name: "EasyEmailError",
      code: "PROVIDER_INSTANCE_ID_REQUIRED",
    } satisfies Partial<EasyEmailError>);
  });

  it("targets the requested MoEmail provider instance when providerInstanceId is provided", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createFetchResponse(200, { emails: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const service = createService([
      createProviderInstance({
        id: "moemail-a",
        metadata: {
          apiBase: "https://moemail-a.example",
          expiryTimeMs: "1800000",
        },
      }),
      createProviderInstance({
        id: "moemail-b",
        metadata: {
          apiBase: "https://moemail-b.example",
          expiryTimeMs: "1800000",
        },
      }),
    ]);

    const result = await service.cleanupMoemailMailboxes(
      300,
      10,
      false,
      "moemail-b",
      new Date("2026-04-24T12:00:00.000Z"),
    );

    expect(result.providerInstanceId).toBe("moemail-b");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("https://moemail-b.example/api/emails");
  });
});
