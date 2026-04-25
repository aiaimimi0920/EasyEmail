import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TempmailLolClient,
  decodeTempmailLolMailboxRef,
  encodeTempmailLolMailboxRef,
  probeTempmailLolInstance,
} from "../../src/providers/tempmail_lol/client.js";

describe("tempmail-lol provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeTempmailLolMailboxRef("inst-1", {
      email: "demo@tempmail.lol",
      token: "token-123",
    });

    expect(decodeTempmailLolMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@tempmail.lol",
      token: "token-123",
    });
  });

  it("retries inbox reads after rate limits before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"Rate Limited"}', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"emails":[],"expired":false}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TempmailLolClient({
      apiBase: "https://api.tempmail.lol/v2",
    });

    await expect(client.getInbox("token-123")).resolves.toEqual({
      emails: [],
      expired: false,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tempmail.lol/v2/inbox?token=token-123",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Accept: "application/json",
          "User-Agent": "TempMailJS/4.4.0",
        }),
      }),
    );
  });

  it("uses mailbox creation to probe the upstream", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeTempmailLolInstance({
      id: "tempmail-lol-default",
      providerTypeKey: "tempmail-lol",
      displayName: "Tempmail.lol Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "tempmail-lol-connector",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://tempmail-lol/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://api.tempmail.lol/v2",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.tempmail.lol/v2/inbox/create",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
  });
});
