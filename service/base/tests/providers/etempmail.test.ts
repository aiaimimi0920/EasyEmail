import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EtempmailClient,
  decodeEtempmailMailboxRef,
  encodeEtempmailMailboxRef,
  probeEtempmailInstance,
} from "../../src/providers/etempmail/client.js";

function cookieHeader(value: string): Headers {
  return new Headers({ "set-cookie": value });
}

describe("etempmail provider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips encoded mailbox credentials", () => {
    const encoded = encodeEtempmailMailboxRef("inst-1", {
      email: "demo@cross.edu.pl",
      recoverKey: "RECOVER123",
      mailboxId: "10154517",
      creationTime: "1777140492",
    });

    expect(decodeEtempmailMailboxRef(encoded, "inst-1")).toEqual({
      email: "demo@cross.edu.pl",
      recoverKey: "RECOVER123",
      mailboxId: "10154517",
      creationTime: "1777140492",
    });
  });

  it("switches mailbox domain when a preferred domain is requested", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "10154517",
        address: "demo@beta.edu.pl",
        creation_time: "1777140492",
        recover_key: "RECOVER1",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=create-cookie; path=/; HttpOnly, lisansimo=1777140492"),
      }))
      .mockResolvedValueOnce(new Response(`
        <form action="https://etempmail.com/changeEmailAddress" method="post">
          <select name="id" id="domains">
            <option value="">Click here to select!</option>
            <option value="20">cross.edu.pl</option>
            <option value="18">beta.edu.pl</option>
          </select>
        </form>
      `, { status: 200 }))
      .mockResolvedValueOnce(new Response("<html></html>", {
        status: 200,
        headers: cookieHeader("ci_session=changed-cookie; path=/; HttpOnly"),
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "10154518",
        address: "demo2@cross.edu.pl",
        creation_time: "1777140493",
        recover_key: "RECOVER2",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=changed-cookie-2; path=/; HttpOnly, lisansimo=1777140493"),
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new EtempmailClient({
      apiBase: "https://etempmail.com",
    });

    await expect(client.createMailbox({ requestedDomain: "cross.edu.pl" })).resolves.toEqual({
      email: "demo2@cross.edu.pl",
      recoverKey: "RECOVER2",
      mailboxId: "10154518",
      creationTime: "1777140493",
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://etempmail.com/getEmailAddress",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://etempmail.com/changeEmailAddress",
      expect.objectContaining({
        method: "POST",
        body: "id=20",
      }),
    );
  });

  it("reads the latest code from inbox detail after recovering the mailbox session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        message: "Email recovery successful!",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=recovered-cookie; path=/; HttpOnly, lisansimo=1777140492"),
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        {
          from: "No Reply <noreply@example.com>",
          subject: "Verify your sign-in",
          date: "2026-04-26T09:10:00.000Z",
        },
      ]), { status: 200 }))
      .mockResolvedValueOnce(new Response(`
        <div class="card-body px-3">
          <iframe height="400px" class="w-100 border-0" src="data:text/html,<meta charset='utf-8'><base target='_blank' /><p>Your verification code is <b>654321</b>.</p>"></iframe>
        </div>
      `, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new EtempmailClient({ apiBase: "https://etempmail.com" });
    const result = await client.tryReadLatestCode(
      "session-1",
      {
        email: "demo@cross.edu.pl",
        recoverKey: "RECOVER123",
      },
      "etempmail_shared_default",
      "example.com",
    );

    expect(result).toEqual(expect.objectContaining({
      id: "etempmail:1",
      sessionId: "session-1",
      providerInstanceId: "etempmail_shared_default",
      sender: "No Reply <noreply@example.com>",
      subject: "Verify your sign-in",
      extractedCode: "654321",
    }));
    expect(result?.htmlBody).toContain("654321");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://etempmail.com/getInbox",
      expect.objectContaining({
        method: "POST",
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://etempmail.com/email?id=1",
      expect.objectContaining({
        method: "GET",
      }),
    );
  });

  it("probes the upstream by opening, listing, and deleting a mailbox", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: "10154517",
        address: "probe@cross.edu.pl",
        creation_time: "1777140492",
        recover_key: "RECOVER1",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=create-cookie; path=/; HttpOnly, lisansimo=1777140492"),
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        message: "Email recovery successful!",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=recovered-cookie; path=/; HttpOnly, lisansimo=1777140492"),
      }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        message: "Email recovery successful!",
      }), {
        status: 200,
        headers: cookieHeader("ci_session=recovered-cookie-2; path=/; HttpOnly, lisansimo=1777140492"),
      }))
      .mockResolvedValueOnce(new Response("", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeEtempmailInstance({
      id: "etempmail-default",
      providerTypeKey: "etempmail",
      displayName: "eTempMail Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "etempmail-connector",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://etempmail/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        apiBase: "https://etempmail.com",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("probe@cross.edu.pl");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://etempmail.com/deleteEmailAddress",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
