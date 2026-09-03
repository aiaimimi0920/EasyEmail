import { afterEach, describe, expect, it, vi } from "vitest";
import {
  M2uClient,
  decodeM2uMailboxRef,
  encodeM2uMailboxRef,
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
      acceptEncoding: "identity",
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
          "Accept-Encoding": "identity",
          "Content-Type": "application/json",
          "User-Agent": "EasyEmailM2U/1.0",
        }),
      }),
    );
  });

  it("creates a custom mailbox from /v1/mailboxes/custom when localPart and turnstile token are provided", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-custom-1",
          token: "token-custom-123",
          view_token: "view-custom-456",
          local_part: "customprefix",
          domain: "shaole.me",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.createMailbox({
      preferredDomain: "shaole.me",
      requestedLocalPart: "customprefix",
      turnstileToken: "cf-token-123",
    })).resolves.toEqual({
      email: "customprefix@shaole.me",
      token: "token-custom-123",
      viewToken: "view-custom-456",
      mailboxId: "mailbox-custom-1",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.m2u.io/v1/mailboxes/custom",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          localPart: "customprefix",
          domain: "shaole.me",
          turnstileToken: "cf-token-123",
        }),
      }),
    );
  });

  it("falls back to auto mailbox flow when custom localPart is requested without a Turnstile token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        domains: ["shaole.me"],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-auto-1",
          token: "token-auto-123",
          view_token: "view-auto-456",
          local_part: "randomauto",
          domain: "shaole.me",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.createMailbox({
      preferredDomain: "shaole.me",
      requestedLocalPart: "customprefix",
    })).resolves.toEqual({
      email: "randomauto@shaole.me",
      token: "token-auto-123",
      viewToken: "view-auto-456",
      mailboxId: "mailbox-auto-1",
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
        body: JSON.stringify({ domain: "shaole.me" }),
      }),
    );
  });

  it("classifies a 200 daily_limit_exceeded createMailbox response as capacity failure", async () => {
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

    await expect(client.createMailbox()).rejects.toThrow(
      "M2U_CAPACITY_FAILURE: M2U createMailbox failed with status 200 (error=daily_limit_exceeded).",
    );
  });

  it("retries with alternate browser-like user agents when the first direct createMailbox attempt is capacity-limited", async () => {
    vi.spyOn(Math, "random")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.999);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "daily_limit_exceeded",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        mailbox: {
          id: "mailbox-alt-ua-1",
          token: "token-alt-123",
          view_token: "view-alt-456",
          local_part: "altua",
          domain: "shaole.me",
          expires_at: "2026-05-01T00:00:00.000Z",
        },
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      userAgents: [
        "EasyEmailM2U/1.0",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
      ],
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
    });

    await expect(client.createMailbox()).resolves.toEqual({
      email: "altua@shaole.me",
      token: "token-alt-123",
      viewToken: "view-alt-456",
      mailboxId: "mailbox-alt-ua-1",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "EasyEmailM2U/1.0",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://api.m2u.io/v1/mailboxes/auto",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
        }),
      }),
    );
  });

  it("falls back to easy-proxy when direct createMailbox is capacity-limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: "daily_limit_exceeded",
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const execFileMock = vi.fn(((file, args, options, callback) => {
      const cb = typeof options === "function" ? options : callback;
      cb?.(
        null,
        JSON.stringify({
          status: 200,
          body: {
            mailbox: {
              id: "mailbox-proxy-1",
              token: "token-proxy-123",
              view_token: "view-proxy-456",
              local_part: "proxy-demo",
              domain: "shaole.me",
              expires_at: "2026-05-01T00:00:00.000Z",
            },
          },
          proxyUrl: "http://easy-proxy-service:24001",
        }),
        "",
      );
      return {} as never;
    }) as unknown as Parameters<typeof setM2uExecFileForTesting>[0]);
    setM2uExecFileForTesting(execFileMock as unknown as Parameters<typeof setM2uExecFileForTesting>[0]);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
      useEasyProxyOnCapacity: true,
      easyProxyBaseUrl: "http://easy-proxy-service:9888",
      easyProxyApiKey: "proxy-key",
      easyProxyRuntimeHost: "easy-proxy-service",
      easyProxyMaxAttempts: 2,
    });

    await expect(client.createMailbox()).resolves.toEqual({
      email: "proxy-demo@shaole.me",
      token: "token-proxy-123",
      viewToken: "view-proxy-456",
      mailboxId: "mailbox-proxy-1",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledTimes(1);
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
      acceptEncoding: "identity",
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

  it("keeps preferredDomain strict even when createMailbox falls back to easy-proxy", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        domains: ["cpu.edu.kg", "do4.tech", "shaole.me"],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "daily_limit_exceeded",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: "daily_limit_exceeded",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    let helperCallCount = 0;
    const execFileMock = vi.fn(((file, args, options, callback) => {
      helperCallCount += 1;
      const cb = typeof options === "function" ? options : callback;
      cb?.(
        null,
        JSON.stringify({
          status: 200,
          body: {
            mailbox: helperCallCount === 1
              ? {
                  id: "mailbox-proxy-1",
                  token: "token-proxy-123",
                  view_token: "view-proxy-456",
                  local_part: "wrong-domain",
                  domain: "shaole.me",
                  expires_at: "2026-05-01T00:00:00.000Z",
                }
              : {
                  id: "mailbox-proxy-2",
                  token: "token-proxy-789",
                  view_token: "view-proxy-999",
                  local_part: "right-domain",
                  domain: "cpu.edu.kg",
                  expires_at: "2026-05-01T00:00:00.000Z",
                },
          },
          proxyUrl: `http://easy-proxy-service:2400${helperCallCount}`,
        }),
        "",
      );
      return {} as never;
    }) as unknown as Parameters<typeof setM2uExecFileForTesting>[0]);
    setM2uExecFileForTesting(execFileMock as unknown as Parameters<typeof setM2uExecFileForTesting>[0]);

    const client = new M2uClient({
      apiBase: "https://api.m2u.io",
      userAgent: "EasyEmailM2U/1.0",
      acceptLanguage: "zh-CN,zh;q=0.9",
      acceptEncoding: "identity",
      useEasyProxyOnCapacity: true,
      easyProxyBaseUrl: "http://easy-proxy-service:9888",
      easyProxyApiKey: "proxy-key",
      easyProxyRuntimeHost: "easy-proxy-service",
      easyProxyMaxAttempts: 2,
    });

    await expect(client.createMailbox({ preferredDomain: "edu.kg" })).resolves.toEqual({
      email: "right-domain@cpu.edu.kg",
      token: "token-proxy-789",
      viewToken: "view-proxy-999",
      mailboxId: "mailbox-proxy-2",
      expiresAt: "2026-05-01T00:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });
});
