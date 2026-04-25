import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSetDefinition } from "../../src/shared/index.js";
import { clearCredentialRuntimeState } from "../../src/shared/index.js";
import {
  decodeMail2925MailboxRef,
  encodeMail2925MailboxRef,
  probeMail2925Instance,
} from "../../src/providers/mail2925/client.js";

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
});
