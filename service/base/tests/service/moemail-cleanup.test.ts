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
import { encodeMoemailMailboxRef } from "../../src/providers/moemail/client.js";
import { MoemailProviderAdapter } from "../../src/providers/moemail/index.js";

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

  it("expires local MoEmail sessions when upstream web delete is unauthorized", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(createFetchResponse(401, { message: "未授权" }));
    vi.stubGlobal("fetch", fetchMock);

    const session = {
      id: "mailbox_20260424120000_0001",
      hostId: "python-register-orchestration",
      providerTypeKey: "moemail" as const,
      providerInstanceId: "moemail-default",
      emailAddress: "demo@sall.cc",
      mailboxRef: encodeMoemailMailboxRef("moemail-default", {
        emailId: "email-unauthorized",
        email: "demo@sall.cc",
        localPart: "demo",
        domain: "sall.cc",
      }),
      status: "open" as const,
      createdAt: "2026-04-24T12:00:00.000Z",
      expiresAt: "2026-04-24T12:30:00.000Z",
      metadata: {
        source: "unit-test",
      },
    };
    const seededService = new EasyEmailService(
      new MailRegistry({
        instances: [createProviderInstance({
          metadata: {
            apiBase: "https://sall.cc",
            webSessionToken: "expired-web-session",
            expiryTimeMs: "1800000",
          },
        })],
        credentialSets: [createCredentialSet("cred-set-1")],
        credentialBindings: [createCredentialBinding("moemail-default", "cred-set-1")],
        sessions: [session],
      }),
      undefined,
      [new MoemailProviderAdapter()],
    );

    const result = await seededService.releaseMailbox(
      session.id,
      "dst_flow_cleanup",
      new Date("2026-04-24T12:05:00.000Z"),
    );

    expect(result).toMatchObject({
      released: false,
      detail: "upstream_delete_unauthorized",
    });
    expect(result.session.status).toBe("expired");
    expect(result.session.metadata.releaseStatus).toBe("skipped");
    expect(result.session.metadata.releaseDetail).toBe("upstream_delete_unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to API-key deletion during cleanup when MoEmail web-session delete is unauthorized", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(200, {
        emails: [
          {
            id: "email-web-expired",
            address: "stale@sall.cc",
            expiresAt: "2026-04-24T12:01:00.000Z",
          },
        ],
      }))
      .mockResolvedValueOnce(createFetchResponse(401, { message: "未授权" }))
      .mockResolvedValueOnce(createFetchResponse(204, ""));
    vi.stubGlobal("fetch", fetchMock);

    const service = createService([
      createProviderInstance({
        metadata: {
          apiBase: "https://sall.cc",
          expiryTimeMs: "1800000",
          webSessionToken: "expired-web-session",
        },
      }),
    ]);

    const result = await service.cleanupMoemailMailboxes(
      300,
      10,
      true,
      undefined,
      new Date("2026-04-24T12:00:00.000Z"),
    );

    expect(result.deletedCount).toBe(1);
    expect(result.skippedCount).toBe(0);
    expect(result.deleted).toContainEqual({
      emailId: "email-web-expired",
      email: "stale@sall.cc",
      detail: "deleted_api_key_after_web_unauthorized",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      "X-API-Key": "test-api-key",
    });
  });
});
