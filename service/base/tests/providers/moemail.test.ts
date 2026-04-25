import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MoemailClient,
  classifyMoemailFailure,
  decodeMoemailMailboxRef,
  encodeMoemailMailboxRef,
} from "../../src/providers/moemail/client.js";
import { EasyEmailError } from "../../src/domain/errors.js";
import { MoemailProviderAdapter } from "../../src/providers/moemail/index.js";
import type {
  ProviderCredentialSet,
  ProviderInstance,
  VerificationMailboxRequest,
} from "../../src/domain/models.js";
import { clearCredentialRuntimeState, type CredentialSetDefinition } from "../../src/shared/index.js";

function createFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function createCredentialSet(): CredentialSetDefinition {
  return {
    id: "moemail-test-credential-set",
    displayName: "MoEmail Test Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
    items: [
      {
        id: "moemail-test-key",
        label: "Primary Key",
        value: "test-api-key",
        metadata: {},
      },
    ],
    metadata: {},
  };
}

function createClient(): MoemailClient {
  return new MoemailClient({
    instanceId: "moemail-inst-1",
    namespace: "test:moemail",
    apiBase: "https://moemail.app",
    credentialSets: [createCredentialSet()],
    preferredDomain: "moemail.app",
    expiryTimeMs: 3_600_000,
  });
}

function createProviderInstance(): ProviderInstance {
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
      domain: "moemail.app",
      expiryTimeMs: "3600000",
    },
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
  };
}

function createProviderCredentialSet(): ProviderCredentialSet {
  return {
    ...createCredentialSet(),
    providerTypeKey: "moemail",
    groupKeys: [],
    metadata: {},
    createdAt: "2026-04-24T00:00:00.000Z",
    updatedAt: "2026-04-24T00:00:00.000Z",
  };
}

function createMailboxRequest(): VerificationMailboxRequest {
  return {
    hostId: "python-register-orchestration",
    provisionMode: "always-create-dedicated",
    bindingMode: "dedicated-instance",
  };
}

describe("moemail mailboxRef", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeMoemailMailboxRef("inst-1", {
      emailId: "email-123",
      email: "demo@moemail.app",
      localPart: "demo",
      domain: "moemail.app",
    });

    expect(decodeMoemailMailboxRef(encoded, "inst-1")).toEqual({
      emailId: "email-123",
      email: "demo@moemail.app",
      localPart: "demo",
      domain: "moemail.app",
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeMoemailMailboxRef("inst-1", {
      emailId: "email-123",
      email: "demo@moemail.app",
    });

    expect(decodeMoemailMailboxRef(encoded, "inst-2")).toBeUndefined();
  });

  it("does not delete a mailbox when conflict recovery hits a transient read failure", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(409, { message: "该邮箱地址已被使用" }))
      .mockResolvedValueOnce(createFetchResponse(200, {
        emails: [
          {
            id: "email-123",
            address: "demo@moemail.app",
          },
        ],
      }))
      .mockResolvedValueOnce(createFetchResponse(500, { message: "temporary upstream failure" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient().createMailbox({ name: "demo@moemail.app" })).rejects.toThrow(/status 409/i);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "GET",
    });
    expect(fetchMock.mock.calls.some(([url, init]) => (
      String(url).includes("/api/emails/email-123")
      && init
      && typeof init === "object"
      && "method" in init
      && init.method === "DELETE"
    ))).toBe(false);
  });

  it("deletes and recreates a mailbox only when the conflicting mailbox is confirmed missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(409, { message: "该邮箱地址已被使用" }))
      .mockResolvedValueOnce(createFetchResponse(200, {
        emails: [
          {
            id: "email-123",
            address: "demo@moemail.app",
          },
        ],
      }))
      .mockResolvedValueOnce(createFetchResponse(404, { message: "not found" }))
      .mockResolvedValueOnce(createFetchResponse(200, {}))
      .mockResolvedValueOnce(createFetchResponse(201, {
        id: "email-456",
        address: "demo@moemail.app",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient().createMailbox({ name: "demo@moemail.app" })).resolves.toEqual({
      emailId: "email-456",
      email: "demo@moemail.app",
      localPart: "demo",
      domain: "moemail.app",
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "DELETE",
    });
    expect(fetchMock.mock.calls[4]?.[1]).toMatchObject({
      method: "POST",
    });
  });

  it("recovers an existing mailbox directly through the account API when it is still accessible", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(200, {
        emails: [
          {
            id: "email-123",
            address: "demo@moemail.app",
          },
        ],
      }))
      .mockResolvedValueOnce(createFetchResponse(200, {
        id: "email-123",
        address: "demo@moemail.app",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient().recoverMailboxByEmailAddress("demo@moemail.app")).resolves.toEqual({
      mailbox: {
        emailId: "email-123",
        email: "demo@moemail.app",
        localPart: "demo",
        domain: "moemail.app",
      },
      strategy: "account_restore",
    });
  });

  it("recreates the same mailbox address when the original mailbox is gone", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(200, {
        emails: [
          {
            id: "email-123",
            address: "demo@moemail.app",
          },
        ],
      }))
      .mockResolvedValueOnce(createFetchResponse(404, { message: "not found" }))
      .mockResolvedValueOnce(createFetchResponse(204, ""))
      .mockResolvedValueOnce(createFetchResponse(201, {
        id: "email-456",
        address: "demo@moemail.app",
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createClient().recoverMailboxByEmailAddress("demo@moemail.app")).resolves.toEqual({
      mailbox: {
        emailId: "email-456",
        email: "demo@moemail.app",
        localPart: "demo",
        domain: "moemail.app",
      },
      strategy: "recreate_same_address",
    });
  });

  it("classifies mailbox conflicts separately from capacity failures", () => {
    const classified = classifyMoemailFailure(new Error("MoEmail generateMailbox failed with status 409. 该邮箱地址已被使用"));

    expect(classified.mailboxConflict).toBe(true);
    expect(classified.kind).toBe("provider");
  });

  it("maps MoEmail capacity failures to stable EasyEmail error codes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createFetchResponse(500, { message: "已达到最大邮箱数量限制" }));
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new MoemailProviderAdapter();

    await expect(adapter.createMailboxSession({
      request: createMailboxRequest(),
      instance: createProviderInstance(),
      credentialSets: [createProviderCredentialSet()],
      now: new Date("2026-04-24T12:00:00.000Z"),
    })).rejects.toMatchObject({
      name: "EasyEmailError",
      code: "MOEMAIL_CAPACITY_EXHAUSTED",
    } satisfies Partial<EasyEmailError>);
  });
});
