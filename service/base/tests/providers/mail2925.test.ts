import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSetDefinition } from "../../src/shared/index.js";
import { clearCredentialRuntimeState } from "../../src/shared/index.js";
import {
  Mail2925Client,
  decodeMail2925MailboxRef,
  encodeMail2925MailboxRef,
  probeMail2925Instance,
} from "../../src/providers/mail2925/client.js";
import type { Mail2925MailboxRefPayload } from "../../src/providers/mail2925/client.js";

describe("mail2925 provider", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.restoreAllMocks();
  });

  it("round-trips mailbox refs", () => {
    const encoded = encodeMail2925MailboxRef("inst-1", {
      aliasAddress: "demo_probe@2925.com",
      accountEmail: "demo@2925.com",
      folderName: "Inbox",
      credentialSetId: "set-1",
      credentialItemId: "item-1",
    });

    expect(decodeMail2925MailboxRef(encoded, "inst-1")).toEqual({
      aliasAddress: "demo_probe@2925.com",
      accountEmail: "demo@2925.com",
      folderName: "Inbox",
      credentialSetId: "set-1",
      credentialItemId: "item-1",
      createdAt: undefined,
    });
  });

  it("probes by logging in and listing folders with the first working account", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/mailv2/auth/weblogin")) {
        const params = new URLSearchParams(String(init?.body ?? ""));
        const uname = params.get("uname");
        if (uname === "bad@2925.com") {
          return new Response('{"code":401,"message":"Invalid password"}', { status: 200 });
        }
        return new Response('{"code":200,"result":{"secLogin":false,"token":"token-good"}}', { status: 200 });
      }

      if (url.startsWith("https://mail.2925.com/mailv2/UserData/folders")) {
        const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        if (auth !== "Bearer token-good") {
          return new Response('{"code":93,"message":"Token解析用户名为空"}', { status: 200 });
        }
        return new Response('{"code":200,"result":{"rows":[{"name":"Inbox"},{"name":"已发送"}]}}', { status: 200 });
      }

      return new Response("{}", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const credentialSets: CredentialSetDefinition[] = [{
      id: "test-set",
      displayName: "2925 Accounts",
      useCases: ["generate", "poll"],
      strategy: "round-robin",
      priority: 100,
      items: [
        { id: "bad", label: "bad", username: "bad@2925.com", password: "bad", priority: 200, metadata: {} },
        { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
      ],
      metadata: {},
    }];

    const probe = await probeMail2925Instance({
      id: "mail2925-default",
      providerTypeKey: "mail2925",
      displayName: "2925 Mail Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "mail2925-webmail",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://mail2925/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://mail.2925.com",
        domain: "2925.com",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, credentialSets);

    expect(probe.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("binds new sessions to the real account inbox instead of a synthetic alias", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/mailv2/auth/weblogin")) {
        return new Response('{"code":200,"result":{"secLogin":false,"token":"token-good"}}', { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Mail2925Client({
      instanceId: "mail2925-default",
      namespace: "test:mail2925",
      apiBase: "https://mail.2925.com",
      credentialSets: [{
        id: "test-set",
        displayName: "2925 Accounts",
        useCases: ["generate", "poll"],
        strategy: "round-robin",
        priority: 100,
        items: [
          { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
        ],
        metadata: {},
      }],
      domain: "2925.com",
      folderName: "Inbox",
      aliasSeparator: "_",
      aliasSuffixLength: 10,
      timeoutSeconds: 20,
    });

    const mailbox = await client.createMailbox({
      sessionHint: "matrix-mail2925",
      createdAt: "2026-04-28T01:31:48.104Z",
    });

    expect(mailbox).toMatchObject({
      aliasAddress: "good_matrixmail@2925.com",
      accountEmail: "good@2925.com",
      folderName: "Inbox",
    });
  });

  it("falls back to summary content when only preview data is available", async () => {
    const currentTimestamp = String(Date.now());
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/mailv2/auth/weblogin")) {
        return new Response('{"code":200,"result":{"secLogin":false,"token":"token-good"}}', { status: 200 });
      }

      if (url.includes("/mailv2/maildata/MailList/mails")) {
        return new Response(JSON.stringify({
          code: 200,
          result: {
            list: [{
              subject: "Cloudflare verification sample",
              toAddress: ["good@2925.com"],
              sender: {
                senderDisplay: "Cloudflare",
                sender: "noreply@notify.cloudflare.com",
              },
              bodyContent: "Hello, Verify this Email Routing addr",
              createTime: currentTimestamp,
            }],
          },
        }), { status: 200 });
      }

      if (url.includes("/mailv2/maildata/MailRead/mails/read")) {
        return new Response('{"code":93,"message":"参数错误"}', { status: 200 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Mail2925Client({
      instanceId: "mail2925-default",
      namespace: "test:mail2925",
      apiBase: "https://mail.2925.com",
      credentialSets: [{
        id: "test-set",
        displayName: "2925 Accounts",
        useCases: ["generate", "poll"],
        strategy: "round-robin",
        priority: 100,
        items: [
          { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
        ],
        metadata: {},
      }],
      domain: "2925.com",
      folderName: "Inbox",
      aliasSeparator: "_",
      aliasSuffixLength: 10,
      timeoutSeconds: 20,
    });

    const mailbox: Mail2925MailboxRefPayload = {
      aliasAddress: "good_matrixmail@2925.com",
      accountEmail: "good@2925.com",
      folderName: "Inbox",
      credentialSetId: "test-set",
      credentialItemId: "good",
    };

    const observed = await client.tryReadLatestCode(
      "session-1",
      mailbox,
      "mail2925-default",
      "notify.cloudflare.com",
    );

    expect(observed).toMatchObject({
      sessionId: "session-1",
      providerInstanceId: "mail2925-default",
      sender: "noreply@notify.cloudflare.com",
      subject: "Cloudflare verification sample",
      textBody: "Hello, Verify this Email Routing addr",
    });
  });

  it("uses configured browser session headers for detail reads without relogin", async () => {
    const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
    const currentTimestamp = String(Date.now());
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: init?.headers as Record<string, string> | undefined });

      if (url.includes("/mailv2/auth/weblogin")) {
        return new Response('{"code":600,"message":"需要人机验证"}', { status: 200 });
      }

      if (url.includes("/mailv2/maildata/MailList/mails")) {
        return new Response(JSON.stringify({
          code: 200,
          result: {
            list: [{
              MessageID: "msg-1",
              subject: "Matrix OTP",
              toAddress: ["good@2925.com"],
              sender: { sender: "bounces@cf-bounce.tx-mail.example.com" },
              createTime: currentTimestamp,
            }],
          },
        }), { status: 200 });
      }

      if (url.includes("/mailv2/maildata/MailRead/mails/read")) {
        return new Response(JSON.stringify({
          code: 200,
          result: {
            MessageID: "msg-1",
            subject: "Matrix OTP",
            toAddress: ["good@2925.com"],
            sender: { sender: "bounces@cf-bounce.tx-mail.example.com" },
            bodyHtmlText: "<p>Your login code is <strong>246810</strong>.</p>",
            createTime: currentTimestamp,
          },
        }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Mail2925Client({
      instanceId: "mail2925-default",
      namespace: "test:mail2925",
      apiBase: "https://mail.2925.com",
      credentialSets: [{
        id: "test-set",
        displayName: "2925 Accounts",
        useCases: ["generate", "poll"],
        strategy: "round-robin",
        priority: 100,
        items: [
          { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
        ],
        metadata: {},
      }],
      domain: "2925.com",
      folderName: "Inbox",
      aliasSeparator: "_",
      aliasSuffixLength: 10,
      timeoutSeconds: 20,
      jwtToken: "jwt-session-token",
      deviceUid: "device-uid-123",
      cookieHeader: "aut=session-cookie",
    });

    const mailbox: Mail2925MailboxRefPayload = {
      aliasAddress: "good_matrixmail@2925.com",
      accountEmail: "good@2925.com",
      folderName: "Inbox",
      credentialSetId: "test-set",
      credentialItemId: "good",
    };

    const observed = await client.tryReadLatestCode(
      "session-1",
      mailbox,
      "mail2925-default",
      "cf-bounce.tx-mail.example.com",
    );

    expect(observed?.extractedCode).toBe("246810");
    expect(requests.some((entry) => entry.url.includes("/mailv2/auth/weblogin"))).toBe(false);

    const detailRequest = requests.find((entry) => entry.url.includes("/mailv2/maildata/MailRead/mails/read"));
    const detailHeaders = detailRequest?.headers as Record<string, string> | undefined;
    expect(detailHeaders?.Authorization).toBe("Bearer jwt-session-token");
    expect(detailHeaders?.deviceUid).toBe("device-uid-123");
    expect(detailHeaders?.Cookie).toBe("aut=session-cookie");
    expect(detailHeaders?.["X-Requested-With"]).toBe("XMLHttpRequest");
    expect(detailHeaders?.Referer).toBe("https://mail.2925.com/");
    expect(detailHeaders?.["User-Agent"]).toContain("Chrome/");
  });

  it("refreshes an expired configured browser session token before retrying mailbox reads", async () => {
    const requests: Array<{ url: string; headers?: Record<string, string> }> = [];
    const currentTimestamp = String(Date.now());
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: init?.headers as Record<string, string> | undefined });

      if (url.includes("/mailv2/maildata/MailList/mails")) {
        const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? "");
        if (auth === "Bearer refreshed-jwt-token") {
          return new Response(JSON.stringify({
            code: 200,
            result: {
              list: [{
                MessageID: "msg-1",
                subject: "Matrix OTP",
                toAddress: ["good@2925.com"],
                sender: { sender: "bounces@cf-bounce.tx-mail.example.com" },
                bodyContent: "Your verification code is 246810.",
                createTime: currentTimestamp,
              }],
            },
          }), { status: 200 });
        }

        return new Response('{"code":401,"message":"token expired"}', { status: 200 });
      }

      if (url.includes("/mailv2/auth/token")) {
        return new Response('{"code":200,"result":"refreshed-jwt-token"}', { status: 200 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Mail2925Client({
      instanceId: "mail2925-default",
      namespace: "test:mail2925",
      apiBase: "https://mail.2925.com",
      credentialSets: [{
        id: "test-set",
        displayName: "2925 Accounts",
        useCases: ["generate", "poll"],
        strategy: "round-robin",
        priority: 100,
        items: [
          { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
        ],
        metadata: {},
      }],
      domain: "2925.com",
      folderName: "Inbox",
      aliasSeparator: "_",
      aliasSuffixLength: 10,
      timeoutSeconds: 20,
      jwtToken: "expired-jwt-token",
      deviceUid: "device-uid-123",
      cookieHeader: "aut=session-cookie",
    });

    const mailbox: Mail2925MailboxRefPayload = {
      aliasAddress: "good_matrixmail@2925.com",
      accountEmail: "good@2925.com",
      folderName: "Inbox",
      credentialSetId: "test-set",
      credentialItemId: "good",
    };

    const observed = await client.tryReadLatestCode(
      "session-1",
      mailbox,
      "mail2925-default",
      "cf-bounce.tx-mail.example.com",
    );

    expect(observed?.extractedCode).toBe("246810");
    expect(requests.filter((entry) => entry.url.includes("/mailv2/maildata/MailList/mails")).length).toBe(2);
    const refreshRequest = requests.find((entry) => entry.url.includes("/mailv2/auth/token"));
    expect(refreshRequest?.headers?.deviceUid).toBe("device-uid-123");
    expect(refreshRequest?.headers?.Cookie).toBe("aut=session-cookie");
  }, 15_000);

  it("prefers detail html over misleading truncated summary codes when a message id is available", async () => {
    const currentTimestamp = String(Date.now());
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("/mailv2/maildata/MailList/mails")) {
        return new Response(JSON.stringify({
          code: 200,
          result: {
            list: [{
              MessageID: "msg-1",
              subject: "Long mixed verification sample",
              toAddress: ["good@2925.com"],
              sender: { sender: "bounces@cf-bounce.tx-mail.example.com" },
              bodyContent: "Account 220044 requires confirmation.Ver",
              createTime: currentTimestamp,
            }],
          },
        }), { status: 200 });
      }

      if (url.includes("/mailv2/maildata/MailRead/mails/read")) {
        return new Response(JSON.stringify({
          code: 200,
          result: {
            MessageID: "msg-1",
            subject: "Long mixed verification sample",
            toAddress: ["good@2925.com"],
            sender: { sender: "bounces@cf-bounce.tx-mail.example.com" },
            bodyHtmlText: "<div>Account 220044 requires confirmation. Verification code: <strong>ZX-41Q8-PLM7</strong>. Ignore ticket 771199.</div>",
            createTime: currentTimestamp,
          },
        }), { status: 200 });
      }

      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new Mail2925Client({
      instanceId: "mail2925-default",
      namespace: "test:mail2925",
      apiBase: "https://mail.2925.com",
      credentialSets: [{
        id: "test-set",
        displayName: "2925 Accounts",
        useCases: ["generate", "poll"],
        strategy: "round-robin",
        priority: 100,
        items: [
          { id: "good", label: "good", username: "good@2925.com", password: "good", priority: 100, metadata: {} },
        ],
        metadata: {},
      }],
      domain: "2925.com",
      folderName: "Inbox",
      aliasSeparator: "_",
      aliasSuffixLength: 10,
      timeoutSeconds: 20,
      jwtToken: "jwt-session-token",
      deviceUid: "device-uid-123",
      cookieHeader: "aut=session-cookie",
    });

    const mailbox: Mail2925MailboxRefPayload = {
      aliasAddress: "good_matrixmail@2925.com",
      accountEmail: "good@2925.com",
      folderName: "Inbox",
      credentialSetId: "test-set",
      credentialItemId: "good",
    };

    const observed = await client.tryReadLatestCode(
      "session-1",
      mailbox,
      "mail2925-default",
      "cf-bounce.tx-mail.example.com",
    );

    expect(observed).toMatchObject({
      extractedCode: "ZX-41Q8-PLM7",
      codeSource: "html",
    });
  });
});
