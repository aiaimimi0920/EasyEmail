import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance, VerificationMailboxRequest } from "../../src/domain/models.js";
import { MAIL_PROVIDER_TYPES } from "../../src/defaults/provider_types/index.js";
import { createDefaultProviderInstances } from "../../src/defaults/provider_instances/index.js";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { createDefaultMailProviderAdapters } from "../../src/providers/index.js";
import { TemporamProviderAdapter } from "../../src/providers/temporam/index.js";
import {
  TemporamClient,
  decodeTemporamMailboxRef,
  encodeTemporamMailboxRef,
  probeTemporamInstance,
} from "../../src/providers/temporam/client.js";

describe("temporam provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("round-trips encoded anonymous mailbox credentials", () => {
    const encoded = encodeTemporamMailboxRef("inst-1", {
      email: "Demo@V2Proxy.com",
      localPart: "Demo",
      domain: "V2Proxy.com",
      openedAt: "2026-06-06T00:00:00.000Z",
    });

    expect(decodeTemporamMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@v2proxy.com",
      localPart: "demo",
      domain: "v2proxy.com",
      openedAt: "2026-06-06T00:00:00.000Z",
    });
  });

  it("creates an anonymous mailbox from the public domains endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T01:00:00.000Z"));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 200,
        error: false,
        data: [{ id: "33", domain: "v2proxy.com" }],
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TemporamClient({
      baseUrl: "https://www.temporam.com",
      userAgent: "EasyEmailTemporam/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.createMailbox({
      requestedLocalPart: "demo",
      preferredDomain: "v2proxy.com",
    })).resolves.toEqual({
      email: "demo@v2proxy.com",
      localPart: "demo",
      domain: "v2proxy.com",
      openedAt: "2026-06-06T01:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.temporam.com/api/domains",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Accept-Encoding": "identity",
          "Accept-Language": "zh-CN,zh;q=0.9",
          "User-Agent": "EasyEmailTemporam/1.0",
        }),
      }),
    );
  });

  it("generates an eight-character local part when no local part is requested", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T01:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 200,
        error: false,
        data: [{ domain: "v2proxy.com" }],
      }), { status: 200 }),
    ));

    const client = new TemporamClient({
      baseUrl: "https://www.temporam.com",
      userAgent: "EasyEmailTemporam/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.createMailbox()).resolves.toEqual({
      email: "aaaaaaaa@v2proxy.com",
      localPart: "aaaaaaaa",
      domain: "v2proxy.com",
      openedAt: "2026-06-06T01:00:00.000Z",
    });
  });

  it("reads the latest code by listing emails and loading detail", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 200,
        error: false,
        data: [
          {
            id: "email-1",
            fromEmail: "noreply@example.com",
            subject: "Verify your account",
            createdAt: "2026-06-06T01:00:00.000Z",
          },
        ],
        meta: { total: 1, page: 1, limit: 50 },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 200,
        error: false,
        data: {
          id: "email-1",
          fromEmail: "noreply@example.com",
          subject: "Verify your account",
          content: "Your verification code is 123456.",
          createdAt: "2026-06-06T01:00:00.000Z",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TemporamClient({
      baseUrl: "https://www.temporam.com",
      userAgent: "EasyEmailTemporam/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    const result = await client.tryReadLatestCode(
      "session-1",
      {
        email: "demo@v2proxy.com",
        localPart: "demo",
        domain: "v2proxy.com",
        openedAt: "2026-06-06T00:50:00.000Z",
      },
      "temporam_shared_default",
      "example.com",
    );

    expect(result).toEqual(expect.objectContaining({
      id: "temporam:email-1",
      sessionId: "session-1",
      providerInstanceId: "temporam_shared_default",
      observedAt: "2026-06-06T01:00:00.000Z",
      sender: "noreply@example.com",
      subject: "Verify your account",
      textBody: "Your verification code is 123456.",
      extractedCode: "123456",
      codeSource: "text",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://www.temporam.com/api/emails?email=demo%40v2proxy.com&since=2026-06-06T00%3A40%3A00.000Z&limit=50",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://www.temporam.com/api/emails/email-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("provider adapter creates a Temporam mailbox session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-06T01:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        code: 200,
        error: false,
        data: [{ domain: "v2proxy.com" }],
      }), { status: 200 }),
    ));

    const adapter = new TemporamProviderAdapter();
    const instance = createTemporamInstance();
    const request: VerificationMailboxRequest = {
      hostId: "signup-flow",
      providerTypeKey: "temporam",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      requestedLocalPart: "demo",
      requestedDomain: "v2proxy.com",
      ttlMinutes: 30,
      metadata: { fromContains: "example.com" },
    };

    const session = await adapter.createMailboxSession({
      request,
      instance,
      credentialSets: [],
      now: new Date("2026-06-06T01:00:00.000Z"),
    });

    expect(session).toEqual(expect.objectContaining({
      hostId: "signup-flow",
      providerTypeKey: "temporam",
      providerInstanceId: "temporam_shared_default",
      emailAddress: "demo@v2proxy.com",
      status: "open",
      createdAt: "2026-06-06T01:00:00.000Z",
      expiresAt: "2026-06-06T01:30:00.000Z",
      metadata: expect.objectContaining({
        fromContains: "example.com",
        selectedDomain: "v2proxy.com",
      }),
    }));
    expect(decodeTemporamMailboxRef(session.mailboxRef, "temporam_shared_default")?.email).toBe("demo@v2proxy.com");
  });

  it("recovers the same Temporam mailbox from a persisted mailboxRef", async () => {
    const adapter = new TemporamProviderAdapter();
    const mailboxRef = encodeTemporamMailboxRef("temporam_shared_default", {
      email: "demo@v2proxy.com",
      localPart: "demo",
      domain: "v2proxy.com",
      openedAt: "2026-06-06T01:00:00.000Z",
    });

    const recovered = await adapter.recoverMailboxSession?.({
      emailAddress: "demo@v2proxy.com",
      hostId: "recovery-flow",
      instance: createTemporamInstance(),
      credentialSets: [],
      now: new Date("2026-06-06T02:00:00.000Z"),
      session: {
        id: "mailbox_old",
        hostId: "signup-flow",
        providerTypeKey: "temporam",
        providerInstanceId: "temporam_shared_default",
        emailAddress: "demo@v2proxy.com",
        mailboxRef,
        status: "expired",
        createdAt: "2026-06-06T01:00:00.000Z",
        metadata: {
          selectedDomain: "v2proxy.com",
          lastCodeObservedAt: "2026-06-06T01:10:00.000Z",
          releaseStatus: "skipped",
        },
      },
    });

    expect(recovered?.strategy).toBe("session_restore");
    expect(recovered?.session.emailAddress).toBe("demo@v2proxy.com");
    expect(recovered?.session.mailboxRef).toBe(mailboxRef);
    expect(recovered?.session.hostId).toBe("recovery-flow");
    expect(recovered?.session.metadata.recoverySource).toBe("provider_session_restore");
    expect(recovered?.session.metadata.lastCodeObservedAt).toBeUndefined();
    expect(recovered?.session.metadata.releaseStatus).toBeUndefined();
  });

  it("probes the upstream by reading public domains", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 200,
      error: false,
      data: [{ domain: "v2proxy.com" }],
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeTemporamInstance(createTemporamInstance());

    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("Temporam returned 1 available domain");
    expect(probe.metadata).toEqual(expect.objectContaining({
      provider: "temporam",
      state: "ok",
      domainsCsv: "v2proxy.com",
    }));
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.temporam.com/api/domains",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("wires Temporam into default catalog, provider registry, and external-api strategy mode", () => {
    const now = new Date("2026-06-06T01:00:00.000Z");
    const config = parseEasyEmailServiceRuntimeConfig({
      strategy: { mode: "external-api" },
    });

    expect(MAIL_PROVIDER_TYPES.some((item) => item.key === "temporam")).toBe(true);
    expect(createDefaultProviderInstances(now).some((item) => item.id === "temporam_shared_default")).toBe(true);
    expect(createDefaultMailProviderAdapters().some((adapter) => adapter.typeKey === "temporam")).toBe(true);
    expect(config.defaultStrategyMode?.providerSelections).toContain("temporam");
  });
});

function createTemporamInstance(): ProviderInstance {
  return {
    id: "temporam_shared_default",
    providerTypeKey: "temporam",
    displayName: "Temporam Default",
    status: "active",
    runtimeKind: "external",
    connectorKind: "temporam-web",
    shared: true,
    costTier: "free",
    healthScore: 0.75,
    averageLatencyMs: 500,
    connectionRef: "external://temporam/default",
    hostBindings: [],
    groupKeys: [],
    metadata: {
      apiBase: "https://www.temporam.com",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    },
    createdAt: "2026-06-06T00:00:00.000Z",
    updatedAt: "2026-06-06T00:00:00.000Z",
  };
}
