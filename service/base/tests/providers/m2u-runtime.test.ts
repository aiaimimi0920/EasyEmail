import { afterEach, describe, expect, it, vi } from "vitest";
import { M2uProviderAdapter } from "../../src/providers/m2u/index.js";
import {
  M2uClient,
  encodeM2uMailboxRef,
  probeM2uInstance,
  setM2uExecFileForTesting,
} from "../../src/providers/m2u/client.js";

describe("m2u provider", () => {
  const originalEnv = {
    EASY_PROXY_BASE_URL: process.env.EASY_PROXY_BASE_URL,
    EASY_PROXY_API_KEY: process.env.EASY_PROXY_API_KEY,
    EASY_PROXY_RUNTIME_HOST: process.env.EASY_PROXY_RUNTIME_HOST,
    M2U_USE_EASY_PROXY_ON_CAPACITY: process.env.M2U_USE_EASY_PROXY_ON_CAPACITY,
    M2U_EASY_PROXY_MAX_ATTEMPTS: process.env.M2U_EASY_PROXY_MAX_ATTEMPTS,
    M2U_UPSTREAM_PROXY_URL: process.env.M2U_UPSTREAM_PROXY_URL,
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    setM2uExecFileForTesting(undefined);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it("reads the latest code from message detail using token + view token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        messages: [
          {
            id: "msg-1",
            from_addr: "no-reply@example.com",
            subject: "Sign in to continue",
            received_at: "2026-04-24T04:40:00.000Z",
          },
        ],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        message: {
          id: "msg-1",
          from_addr: "no-reply@example.com",
          subject: "Sign in to continue",
          text_body: "Your verification code is 123456.",
          html_body: "<p>Your verification code is <strong>123456</strong>.</p>",
          received_at: "2026-04-24T04:40:00.000Z",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    const result = await client.tryReadLatestCode(
      "mailbox-1",
      {
        email: "demo@cpu.edu.kg",
        token: "token-123",
        viewToken: "view-456",
      },
      "m2u_shared_default",
      "example.com",
    );

    expect(result).toEqual(expect.objectContaining({
      id: "m2u:msg-1",
      sessionId: "mailbox-1",
      providerInstanceId: "m2u_shared_default",
      sender: "no-reply@example.com",
      extractedCode: "123456",
      codeSource: "text",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.m2u.io/v1/mailboxes/token-123/messages?view=view-456",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.m2u.io/v1/mailboxes/token-123/messages/msg-1?view=view-456",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("recovers the same mailbox address from a persisted mailboxRef", async () => {
    const adapter = new M2uProviderAdapter();
    const now = new Date("2026-04-26T06:30:00.000Z");
    const mailboxRef = encodeM2uMailboxRef("m2u_shared_default", {
      email: "demo@cpu.edu.kg",
      token: "token-123",
      viewToken: "view-456",
      mailboxId: "mailbox-1",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });

    const recovered = await adapter.recoverMailboxSession({
      emailAddress: "demo@cpu.edu.kg",
      hostId: "oauth-recovery",
      instance: {
        id: "m2u_shared_default",
        providerTypeKey: "m2u",
        displayName: "MailToYou Default",
        status: "active",
        runtimeKind: "external",
        connectorKind: "m2u-api",
        shared: true,
        costTier: "free",
        healthScore: 1,
        averageLatencyMs: 0,
        connectionRef: "external://m2u/default",
        hostBindings: [],
        groupKeys: [],
        metadata: {},
        createdAt: "2026-04-01T00:00:00.000Z",
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      credentialSets: [],
      now,
      session: {
        id: "mailbox_old",
        hostId: "signup-flow",
        providerTypeKey: "m2u",
        providerInstanceId: "m2u_shared_default",
        emailAddress: "demo@cpu.edu.kg",
        mailboxRef,
        status: "expired",
        createdAt: "2026-04-26T06:10:00.000Z",
        expiresAt: "2026-05-01T00:00:00.000Z",
        metadata: {
          selectedDomain: "cpu.edu.kg",
          lastCodeObservedAt: "2026-04-26T06:12:00.000Z",
          lastCodeMessageId: "m2u:msg-1",
          releasedAt: "2026-04-26T06:14:00.000Z",
          releaseStatus: "skipped",
        },
      },
    });

    expect(recovered).toBeDefined();
    expect(recovered?.strategy).toBe("session_restore");
    expect(recovered?.session.emailAddress).toBe("demo@cpu.edu.kg");
    expect(recovered?.session.mailboxRef).toBe(mailboxRef);
    expect(recovered?.session.id).not.toBe("mailbox_old");
    expect(recovered?.session.hostId).toBe("oauth-recovery");
    expect(recovered?.session.metadata.recoverySource).toBe("provider_session_restore");
    expect(recovered?.session.metadata.notBeforeAt).toBe(now.toISOString());
    expect(recovered?.session.metadata.lastCodeObservedAt).toBeUndefined();
    expect(recovered?.session.metadata.releaseStatus).toBeUndefined();
  });

  it("uses domain discovery to probe the upstream", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('{"domains":["cpu.edu.kg","tmail.bio"]}', { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          mailbox: {
            id: "mailbox-probe-1",
            token: "token-probe-123",
            view_token: "view-probe-456",
            local_part: "probe",
            domain: "cpu.edu.kg",
            expires_at: "2026-05-01T00:00:00.000Z",
          },
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeM2uInstance({
      id: "m2u-default",
      providerTypeKey: "m2u",
      displayName: "MailToYou Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "m2u-api",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://m2u/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://api.m2u.io",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("createMailbox smoke check succeeded");
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.m2u.io/v1/domains",
      expect.objectContaining({
        method: "GET",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });

  it("keeps a cached successful probe after legacy mailbox-domain risk feedback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-04T00:02:00.000Z"));

    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('{"domains":["cpu.edu.kg","tmail.bio"]}', { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeM2uInstance({
      id: "m2u-default",
      providerTypeKey: "m2u",
      displayName: "MailToYou Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "m2u-api",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://m2u/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://api.m2u.io",
        lastProbeCreateMailboxAt: "2026-06-04T00:00:00.000Z",
        lastProbeCreateMailboxOk: "true",
        lastProbeCreateMailboxEmail: "probe@safe.test",
        lastProbeCreateMailboxDetail: "cached smoke ok",
        probeMailboxSmokeIntervalSeconds: "900",
        lastRegistrationOutcome: "failure",
        lastRegistrationOutcomeAt: "2026-06-04T00:01:00.000Z",
        lastRegistrationFailureReason: "unsupported_email",
        lastRegistrationAttributionKind: "mailbox_domain_risk",
        lastRegistrationAttributionStrength: "strong",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(probe.detail).toBe("cached smoke ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.m2u.io/v1/domains",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("treats a 200 error body from domains endpoint as a capacity failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: "daily_limit_exceeded",
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.getDomains()).rejects.toThrow(
      "M2U_CAPACITY_FAILURE: M2U getDomains failed with status 200 (error=daily_limit_exceeded).",
    );
  });

  it("marks the probe as failed when createMailbox smoke check is capacity-limited", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response('{"domains":["cpu.edu.kg","tmail.bio"]}', { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "daily_limit_exceeded",
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "daily_limit_exceeded",
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: "daily_limit_exceeded",
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeM2uInstance({
      id: "m2u-default",
      providerTypeKey: "m2u",
      displayName: "MailToYou Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "m2u-api",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://m2u/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://api.m2u.io",
        acceptEncoding: "identity",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(false);
    expect(probe.detail).toContain("daily_limit_exceeded");
    expect(probe.metadata?.errorClass).toBe("capacity");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });
});
