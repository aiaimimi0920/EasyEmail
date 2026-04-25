import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TmailorClient,
  decodeTmailorMailboxRef,
  encodeTmailorMailboxRef,
  probeTmailorInstance,
} from "../../src/providers/tmailor/client.js";

describe("tmailor provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeTmailorMailboxRef("inst-1", {
      email: "demo@tmailor.com",
      token: "access-token-123",
    });

    expect(decodeTmailorMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@tmailor.com",
      token: "access-token-123",
    });
  });

  it("returns undefined for mismatched instance id", () => {
    const encoded = encodeTmailorMailboxRef("inst-1", {
      email: "demo@tmailor.com",
      token: "access-token-123",
    });

    expect(decodeTmailorMailboxRef(encoded, "inst-2")).toBeUndefined();
  });

  it("creates a mailbox via newemail action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        msg: "ok",
        email: "test123@tmailor.com",
        accesstoken: "jwt-token-xyz",
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const mailbox = await client.createMailbox();

    expect(mailbox).toEqual({
      email: "test123@tmailor.com",
      token: "jwt-token-xyz",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tmailor.com/api",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "newemail",
          fbToken: null,
          curentToken: null,
        }),
      }),
    );
  });

  it("throws on non-ok msg from createMailbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ msg: "error", reason: "blocked" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    await expect(client.createMailbox()).rejects.toThrow("TMAILOR_PROVIDER_FAILURE");
  });

  it("lists inbox messages via listinbox action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        msg: "ok",
        code: "list-id-1",
        data: {
          "msg-1": {
            id: "msg-1",
            uuid: "uuid-msg-1",
            subject: "Your code is 123456",
            sender_email: "noreply@example.com",
            sender_name: "Noreply",
            receive_time: 1712500000,
          },
        },
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const inbox = await client.listInbox("my-token");

    expect(Object.keys(inbox)).toHaveLength(1);
    expect(inbox["msg-1"]!.subject).toBe("Your code is 123456");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://tmailor.com/api",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          action: "listinbox",
          accesstoken: "my-token",
          curentToken: "my-token",
          fbToken: null,
        }),
      }),
    );
  });

  it("extracts OTP from inbox summary without reading detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        msg: "ok",
        data: {
          "msg-1": {
            id: "msg-1",
            uuid: "uuid-msg-1",
            subject: "Your verification code is 837291",
            sender_email: "noreply@example.com",
            sender_name: "Noreply",
            receive_time: 1712500000,
          },
        },
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const result = await client.tryReadLatestCode(
      "session-1",
      { email: "test@tmailor.com", token: "my-token" },
      "inst-1",
    );

    expect(result).toBeDefined();
    expect(result!.extractedCode).toBe("837291");
    expect(result!.id).toBe("tmailor:msg-1");
    // Only listinbox was called, no detail read needed
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to detail read when summary has no code", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          msg: "ok",
          data: {
            "msg-1": {
              id: "msg-1",
              uuid: "uuid-msg-1",
              subject: "Welcome to our service",
              sender_email: "noreply@example.com",
              sender_name: "Noreply",
              receive_time: 1712500000,
            },
          },
        }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          msg: "ok",
          data: {
            id: "msg-1",
            subject: "Welcome to our service",
            sender_email: "noreply@example.com",
            textBody: "Your verification code is 554433. It expires in 10 minutes.",
            htmlBody: "<p>Your verification code is <b>554433</b></p>",
          },
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const result = await client.tryReadLatestCode(
      "session-1",
      { email: "test@tmailor.com", token: "my-token" },
      "inst-1",
    );

    expect(result).toBeDefined();
    expect(result!.extractedCode).toBe("554433");
    expect(result!.htmlBody).toContain("554433");
    // listinbox + read detail
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries on 429 before succeeding", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{"error":"rate limited"}', { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          msg: "ok",
          email: "retry@tmailor.com",
          accesstoken: "token-retry",
        }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const mailbox = await client.createMailbox();

    expect(mailbox.email).toBe("retry@tmailor.com");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("probes instance by creating a test mailbox", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        msg: "ok",
        email: "probe@tmailor.com",
        accesstoken: "probe-token",
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeTmailorInstance({
      id: "tmailor-default",
      providerTypeKey: "tmailor",
      displayName: "Tmailor Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "tmailor-connector",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://tmailor/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://tmailor.com",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("probe@tmailor.com");
  });

  it("respects fromContains sender filter", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        msg: "ok",
        data: {
          "msg-1": {
            id: "msg-1",
            uuid: "uuid-msg-1",
            subject: "Your code is 111111",
            sender_email: "spam@ads.com",
          },
          "msg-2": {
            id: "msg-2",
            uuid: "uuid-msg-2",
            subject: "Your code is 222222",
            sender_email: "noreply@myapp.com",
          },
        },
      }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = new TmailorClient({ apiBase: "https://tmailor.com" });
    const result = await client.tryReadLatestCode(
      "session-1",
      { email: "test@tmailor.com", token: "my-token" },
      "inst-1",
      "myapp.com",
    );

    expect(result).toBeDefined();
    expect(result!.extractedCode).toBe("222222");
  });
});
