import { describe, expect, it } from "vitest";
import {
  Im215Client,
  decodeIm215MailboxRef,
  encodeIm215MailboxRef,
} from "../../src/providers/im215/client.js";

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
        const prefix = typeof payload.prefix === "string" ? payload.prefix : "mailbox";
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
