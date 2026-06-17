import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../../src/domain/models.js";
import {
  Im215Client,
  decodeIm215MailboxRef,
  encodeIm215MailboxRef,
} from "../../src/providers/im215/client.js";
import { Im215ProviderAdapter } from "../../src/providers/im215/index.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("im215 mailboxRef", () => {
  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeIm215MailboxRef("inst-1", {
      address: "demo@215.im",
      mailboxId: "mailbox-123",
      domain: "215.im",
      tempToken: "tmp_abc",
    });

    expect(decodeIm215MailboxRef(encoded, "inst-1")).toEqual({
      address: "demo@215.im",
      mailboxId: "mailbox-123",
      domain: "215.im",
      tempToken: "tmp_abc",
      createdAt: undefined,
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeIm215MailboxRef("inst-1", {
      address: "demo@215.im",
    });

    expect(decodeIm215MailboxRef(encoded, "inst-2")).toBeUndefined();
  });

  it("unwraps nested message detail payloads so text/html bodies remain available", async () => {
    const originalFetch = globalThis.fetch;
    const fetchMock = async (input: string) => {
      if (input.endsWith("/messages/message-1")) {
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: "message-1",
            text: "Use code 445566 to continue.",
            html: ["<div>Use code <strong>445566</strong> to continue.</div>"],
          },
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    };
    globalThis.fetch = fetchMock;

    try {
      const client = new Im215Client({
        instanceId: "im215-default",
        namespace: "test:im215",
        apiBase: "https://maliapi.215.im/v1",
        credentialSets: [{
          id: "set-1",
          displayName: "Inline 215.im API Key",
          useCases: ["poll"],
          strategy: "round-robin",
          priority: 100,
          items: [{ id: "item-1", label: "primary", value: "api-key-1", metadata: {} }],
          metadata: {},
        }],
        timeoutSeconds: 20,
      });

      const detail = await client.getMessage("message-1");
      expect(detail).toMatchObject({
        id: "message-1",
        text: "Use code 445566 to continue.",
      });
      expect(Array.isArray(detail.html)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rotates public domains across mailbox creations instead of pinning the first API domain", async () => {
    const originalFetch = globalThis.fetch;
    const accountPayloads: Record<string, unknown>[] = [];
    const fetchMock = async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/domains")) {
        return new Response(JSON.stringify({
          success: true,
          data: [
            { domain: "007.hzeg.eu.org", isPublic: true, isVerified: true, isMxValid: true, dnsRecords: { receivingReady: true } },
            { domain: "alpha.example", isPublic: true, isVerified: true, isMxValid: true, dnsRecords: { receivingReady: true } },
            { domain: "beta.example", isPublic: true, isVerified: true, isMxValid: true, dnsRecords: { receivingReady: true } },
          ],
        }), { status: 200 });
      }

      if (input.endsWith("/accounts")) {
        const payload = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        accountPayloads.push(payload);
        const domain = typeof payload.domain === "string" ? payload.domain : "missing.example";
        const prefix = typeof payload.localPart === "string" ? payload.localPart : "mailbox";
        return new Response(JSON.stringify({
          success: true,
          data: {
            address: `${prefix}@${domain}`,
            domain,
          },
        }), { status: 201 });
      }

      throw new Error(`Unexpected request: ${input}`);
    };
    globalThis.fetch = fetchMock;

    try {
      const client = new Im215Client({
        instanceId: "im215-default",
        namespace: "test:im215:rotate-domains",
        apiBase: "https://maliapi.215.im/v1",
        credentialSets: [{
          id: "set-1",
          displayName: "Inline 215.im API Key",
          useCases: ["generate", "poll"],
          strategy: "round-robin",
          priority: 100,
          items: [{ id: "item-1", label: "primary", value: "api-key-1", metadata: {} }],
          metadata: {},
        }],
        timeoutSeconds: 20,
      });

      await client.createMailbox({ suggestedLocalPart: "first" });
      await client.createMailbox({ suggestedLocalPart: "second" });
      await client.createMailbox({ suggestedLocalPart: "third" });

      expect(accountPayloads.map((payload) => payload.domain)).toEqual([
        "007.hzeg.eu.org",
        "alpha.example",
        "beta.example",
      ]);
      expect(accountPayloads.every((payload) => typeof payload.localPart === "string")).toBe(true);
      expect(accountPayloads.every((payload) => payload.prefix === undefined)).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("recreates an exact same-address mailbox with localPart and domain fields", async () => {
    const accountPayloads: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/accounts")) {
        const payload = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        accountPayloads.push(payload);
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: "mailbox-1",
            address: "demo@007.hzeg.eu.org",
            domain: "007.hzeg.eu.org",
          },
        }), { status: 201 });
      }

      throw new Error(`Unexpected request: ${input}`);
    }));

    const client = createClient();
    const mailbox = await client.recreateMailboxByEmailAddress("Demo@007.HZEG.EU.ORG");

    expect(mailbox).toEqual(expect.objectContaining({
      address: "demo@007.hzeg.eu.org",
      mailboxId: "mailbox-1",
      domain: "007.hzeg.eu.org",
    }));
    expect(accountPayloads).toEqual([{
      localPart: "demo",
      domain: "007.hzeg.eu.org",
    }]);
  });

  it("treats an already-existing exact im215 address as recoverable", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/accounts")) {
        const payload = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        expect(payload).toEqual({
          localPart: "demo",
          domain: "007.hzeg.eu.org",
        });
        return new Response(JSON.stringify({
          success: false,
          error: "account already exists",
        }), { status: 409 });
      }

      throw new Error(`Unexpected request: ${input}`);
    }));

    await expect(createClient().recreateMailboxByEmailAddress("demo@007.hzeg.eu.org"))
      .resolves.toEqual({
        address: "demo@007.hzeg.eu.org",
        domain: "007.hzeg.eu.org",
      });
  });

  it("provider adapter recovers an im215 mailbox by recreating the same email address", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.endsWith("/accounts")) {
        const payload = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        expect(payload).toEqual({
          localPart: "demo",
          domain: "007.hzeg.eu.org",
        });
        return new Response(JSON.stringify({
          success: true,
          data: {
            id: "mailbox-1",
            address: "demo@007.hzeg.eu.org",
            domain: "007.hzeg.eu.org",
          },
        }), { status: 201 });
      }

      throw new Error(`Unexpected request: ${input}`);
    }));

    const adapter = new Im215ProviderAdapter();
    if (!adapter.recoverMailboxSession) {
      throw new Error("Im215ProviderAdapter does not implement recoverMailboxSession.");
    }

    const recovered = await adapter.recoverMailboxSession({
      emailAddress: "demo@007.hzeg.eu.org",
      hostId: "recovery-flow",
      instance: createIm215Instance(),
      credentialSets: [],
      now: new Date("2026-06-17T01:00:00.000Z"),
    });

    expect(recovered?.strategy).toBe("recreate_same_address");
    expect(recovered?.detail).toContain("same-address");
    expect(recovered?.session).toEqual(expect.objectContaining({
      hostId: "recovery-flow",
      providerTypeKey: "im215",
      providerInstanceId: "im215-default",
      emailAddress: "demo@007.hzeg.eu.org",
      status: "open",
      createdAt: "2026-06-17T01:00:00.000Z",
    }));
    expect(decodeIm215MailboxRef(recovered?.session.mailboxRef ?? "", "im215-default")).toEqual(expect.objectContaining({
      address: "demo@007.hzeg.eu.org",
      mailboxId: "mailbox-1",
      domain: "007.hzeg.eu.org",
    }));
    expect(recovered?.session.metadata).toEqual(expect.objectContaining({
      recoveredFromEmailAddress: "demo@007.hzeg.eu.org",
      recoveryStrategy: "recreate_same_address",
      recoverySource: "same_address_recreation",
    }));
  });
});

function createClient(): Im215Client {
  return new Im215Client({
    instanceId: "im215-default",
    namespace: "test:im215:exact-recovery",
    apiBase: "https://maliapi.215.im/v1",
    credentialSets: [{
      id: "set-1",
      displayName: "Inline 215.im API Key",
      useCases: ["generate", "poll"],
      strategy: "round-robin",
      priority: 100,
      items: [{ id: "item-1", label: "primary", value: "api-key-1", metadata: {} }],
      metadata: {},
    }],
    timeoutSeconds: 20,
  });
}

function createIm215Instance(): ProviderInstance {
  return {
    id: "im215-default",
    providerTypeKey: "im215",
    displayName: "215.im",
    status: "active",
    runtimeKind: "external",
    connectorKind: "api",
    shared: true,
    costTier: "free",
    healthScore: 1,
    averageLatencyMs: 100,
    connectionRef: "im215-default",
    hostBindings: [],
    groupKeys: ["im215"],
    metadata: {
      apiBase: "https://maliapi.215.im/v1",
      apiKey: "api-key-1",
    },
    createdAt: "2026-06-17T00:00:00.000Z",
    updatedAt: "2026-06-17T00:00:00.000Z",
  };
}
