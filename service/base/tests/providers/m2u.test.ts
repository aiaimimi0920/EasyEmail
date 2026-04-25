import { afterEach, describe, expect, it, vi } from "vitest";
import {
  M2uClient,
  decodeM2uMailboxRef,
  encodeM2uMailboxRef,
  probeM2uInstance,
} from "../../src/providers/m2u/client.js";

describe("m2u provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeM2uMailboxRef("inst-1", {
      email: "demo@cpu.edu.kg",
      token: "token-123",
      viewToken: "view-456",
      mailboxId: "mailbox-789",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });

    expect(decodeM2uMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@cpu.edu.kg",
      token: "token-123",
      viewToken: "view-456",
      mailboxId: "mailbox-789",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
  });

  it("creates a mailbox from /v1/mailboxes/auto", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-1",
          token: "token-123",
          view_token: "view-456",
          local_part: "demo",
          domain: "cpu.edu.kg",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
    });

    await expect(client.createMailbox()).resolves.toEqual({
      email: "demo@cpu.edu.kg",
      token: "token-123",
      viewToken: "view-456",
      mailboxId: "mailbox-1",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        method: "POST",
        body: "{}",
        headers: expect.objectContaining({
          Accept: "application/json",
          "Content-Type": "application/json",
          "User-Agent": "EasyEmailM2U/1.0",
        }),
      }),
    );
  });

  it("retries until the mailbox matches a preferred domain suffix", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        domains: ["cpu.edu.kg", "do4.tech", "kkb.qzz.io"],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-1",
          token: "token-123",
          view_token: "view-456",
          local_part: "demo-a",
          domain: "kkb.qzz.io",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-2",
          token: "token-789",
          view_token: "view-999",
          local_part: "demo-b",
          domain: "cpu.edu.kg",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
    });

    await expect(client.createMailbox({ preferredDomain: "edu.kg" })).resolves.toEqual({
      email: "demo-b@cpu.edu.kg",
      token: "token-789",
      viewToken: "view-999",
      mailboxId: "mailbox-2",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
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
        body: JSON.stringify({ domain: "cpu.edu.kg" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ domain: "cpu.edu.kg" }),
      }),
    );
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

  it("uses domain discovery to probe the upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
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
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.m2u.io/v1/domains",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });
});
