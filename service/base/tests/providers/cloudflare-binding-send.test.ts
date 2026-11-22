import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTempEmailCreateClient } from "../../src/providers/cloudflare_temp_email/connector/client.js";
import { createCloudflareInstance } from "./cloudflare-temp-email-test-support.js";

const mailbox = { address: "sender@allowed.example.test", jwt: "mailbox-secret" };
const request = { toEmailAddress: "recipient@example.test", subject: "Controlled send", textBody: "Plain body" };

function client(sendTransport = "binding", adminAuth = "admin-secret") {
  const instance = createCloudflareInstance();
  instance.metadata = { ...instance.metadata, sendTransport, adminAuth, customAuth: "custom-secret" };
  return CloudflareTempEmailCreateClient.fromInstance(instance)!;
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("explicit Cloudflare binding transport", () => {
  it("uses only the native admin endpoint with the session sender and both bodies", async () => {
    const fetchMock = vi.fn(async (_input: string, _init?: RequestInit) => new Response('{"status":"ok"}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await client().sendMailboxMessage(mailbox, {
      ...request, fromName: "Sender Name", toName: "Recipient Name", htmlBody: "<p>HTML body</p>",
    });
    expect(result).toEqual({ deliveryMode: "native_binding" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("https://temp.example.test/admin/send_mail_by_binding", expect.objectContaining({
      method: "POST", redirect: "error",
      headers: expect.objectContaining({ "x-custom-auth": "custom-secret", "x-admin-auth": "admin-secret" }),
    }));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(init.body as string)).toEqual({
      from: { email: mailbox.address, name: "Sender Name" },
      to: [{ email: request.toEmailAddress, name: "Recipient Name" }],
      subject: request.subject, text: "Plain body", html: "<p>HTML body</p>",
    });
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("uses string addresses without names and omits empty alternative bodies", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      expect(JSON.parse(init?.body as string)).toEqual({
        from: mailbox.address, to: [request.toEmailAddress], subject: request.subject, html: "<p>HTML</p>",
      });
      return new Response('{"status":"ok"}');
    });
    vi.stubGlobal("fetch", fetchMock);
    await client().sendMailboxMessage(mailbox, { ...request, textBody: " ", htmlBody: "<p>HTML</p>" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 429, 500])("does not change transport or replay HTTP %i", async (status) => {
    const fetchMock = vi.fn(async () => new Response("Backend result unavailable", { status }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().sendMailboxMessage(mailbox, request)).rejects.toThrow(`status ${status}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["ECONNRESET", "UND_ERR_SOCKET", "AbortError"])("does not replay an uncertain %s", async (code) => {
    const error = code === "AbortError" ? new DOMException("Aborted", code) : Object.assign(new Error("Lost acknowledgement"), { code });
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().sendMailboxMessage(mailbox, request)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails before network access without admin credentials", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(client("binding", "").sendMailboxMessage(mailbox, request)).rejects.toThrow("adminAuth");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("preserves only the existing pre-send connect-timeout recovery on the same endpoint", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(Object.assign(new Error("Connect timed out"), { code: "UND_ERR_CONNECT_TIMEOUT" }))
      .mockResolvedValueOnce(new Response('{"status":"ok"}'));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);
    expect(await client().sendMailboxMessage(mailbox, request)).toEqual({ deliveryMode: "native_binding" });
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).pathname))
      .toEqual(["/admin/send_mail_by_binding", "/admin/send_mail_by_binding"]);
  });

  it.each(["auto", "native", "", "BINDING"])("rejects an invalid stored mode without choosing a backend: %s", (mode) => {
    expect(() => client(mode)).toThrow("sendTransport");
  });

  it("keeps explicit worker mode isolated from the binding instance", async () => {
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      paths.push(new URL(input).pathname);
      return new Response('{"status":"ok"}');
    }));
    await client().sendMailboxMessage(mailbox, request);
    expect(await client("worker").sendMailboxMessage(mailbox, request)).toEqual({ deliveryMode: "mailbox_token" });
    expect(paths).toEqual(["/admin/send_mail_by_binding", "/api/request_send_mail_access", "/api/send_mail"]);
  });
});
