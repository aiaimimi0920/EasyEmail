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
});
