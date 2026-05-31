import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DuckMailClient,
  decodeDuckMailMailboxRef,
  encodeDuckMailMailboxRef,
} from "../../src/providers/duckmail/client.js";

function createFetchResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("duckmail mailboxRef", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeDuckMailMailboxRef("inst-1", {
      email: "demo@duckmail.sbs",
      token: "token-123",
      password: "password-123",
      accountId: "account-123",
    });

    expect(decodeDuckMailMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@duckmail.sbs",
      token: "token-123",
      password: "password-123",
      accountId: "account-123",
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeDuckMailMailboxRef("inst-1", {
      email: "demo@duckmail.sbs",
      token: "token-123",
      password: "password-123",
      accountId: "account-123",
    });

    expect(decodeDuckMailMailboxRef(encoded, "inst-2")).toBeUndefined();
  });

  it("rotates public domains across mailbox creations instead of pinning the first API domain", async () => {
    const accountDomains: string[] = [];
    const fetchMock = vi.fn(async (input: string, init?: { body?: string }) => {
      if (input.includes("/domains")) {
        return createFetchResponse(200, {
          "hydra:member": [
            { domain: "duckmail.sbs", isVerified: true },
            { domain: "baldur.edu.kg", isVerified: true },
          ],
        });
      }

      if (input.endsWith("/accounts")) {
        const payload = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
        const address = String(payload.address ?? "");
        const domain = address.split("@")[1] ?? "";
        accountDomains.push(domain);
        return createFetchResponse(201, {
          id: `account-${accountDomains.length}`,
          address,
        });
      }

      if (input.endsWith("/token")) {
        return createFetchResponse(200, { token: "token-123" });
      }

      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new DuckMailClient({
      apiBase: "https://api.duckmail.test",
      passwordLength: 12,
    });

    await client.createMailbox({ suggestedLocalPart: "first" });
    await client.createMailbox({ suggestedLocalPart: "second" });
    await client.createMailbox({ suggestedLocalPart: "third" });

    expect(accountDomains).toEqual([
      "duckmail.sbs",
      "baldur.edu.kg",
      "duckmail.sbs",
    ]);
  });
});
