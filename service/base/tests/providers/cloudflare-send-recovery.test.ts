import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTempEmailCreateClient } from "../../src/providers/cloudflare_temp_email/connector/client.js";

const mailbox = { address: "sender@example.test", jwt: "mailbox-secret" };
const message = { toEmailAddress: "recipient@example.test", subject: "Controlled send", textBody: "Test body" };

function createClient(adminAuth: string | undefined = "admin-secret") {
  return new CloudflareTempEmailCreateClient({
    baseUrl: "https://worker.example.test", customAuth: "custom-secret", adminAuth,
    domains: ["example.test"], randomSubdomainDomains: [], timeoutSeconds: 5,
  });
}

function mockSend(status: number, detail: string) {
  const paths: string[] = [];
  const fetchMock = vi.fn(async (input: string) => {
    const path = new URL(input).pathname;
    paths.push(path);
    if (path === "/api/request_send_mail_access") return new Response('{"status":"ok"}');
    if (path === "/api/send_mail") return new Response(detail, { status });
    if (path === "/admin/send_mail") return new Response('{"status":"ok"}');
    throw new Error("Unexpected test endpoint");
  });
  vi.stubGlobal("fetch", fetchMock);
  return { paths, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("Cloudflare send fallback safety", () => {
  it.each([
    [400, "Resend error: validation_error Sending domain is not verified"],
    [400, "Failed to send mail SMTP delivery acknowledgement lost"],
    [400, "Failed to send mail Server daily sending limit exceeded"],
    [400, "No balance after accepting the message"],
    [400, "Failed to send mail Resend error: No balance"],
    [429, "Failed to send mail Rate limited"],
    [500, "Failed to send mail SMTP result is unknown"],
    [500, "No balance"],
  ])("does not replay an ambiguous or permanent rejection (%i, %s)", async (status, detail) => {
    const { paths } = mockSend(status as number, detail as string);
    await expect(createClient().sendMailboxMessage(mailbox, message)).rejects.toThrow(`status ${status}`);
    expect(paths).toEqual(["/api/request_send_mail_access", "/api/send_mail"]);
  });

  it.each(["No balance", "Failed to send mail No balance", "余额不足", "Failed to send mail 余额不足"])(
    "preserves admin delegation for the exact pre-send balance rejection: %s", async (detail) => {
      const { paths, fetchMock } = mockSend(400, detail);
      expect(await createClient().sendMailboxMessage(mailbox, message)).toEqual({
        deliveryMode: "admin_delegate", detail: "mailbox_token_fallback_to_admin",
      });
      expect(paths).toEqual(["/api/request_send_mail_access", "/api/send_mail", "/admin/send_mail"]);
      expect(fetchMock.mock.calls[2]?.[0]).toBe("https://worker.example.test/admin/send_mail");
    },
  );

  it.each([401, 403])("preserves admin delegation after a mailbox authentication rejection (%i)", async (status) => {
    const { paths } = mockSend(status, "Unauthorized");
    expect((await createClient().sendMailboxMessage(mailbox, message)).deliveryMode).toBe("admin_delegate");
    expect(paths.at(-1)).toBe("/admin/send_mail");
  });

  it("does not delegate without configured admin credentials", async () => {
    const { paths } = mockSend(400, "No balance");
    await expect(createClient("").sendMailboxMessage(mailbox, message)).rejects.toThrow("No balance");
    expect(paths).toHaveLength(2);
  });

  it("does not treat an arbitrary thrown error message as a confirmed HTTP access rejection", async () => {
    const error = new Error("Failed to send mail status 400 No balance");
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('{"status":"ok"}')).mockRejectedValueOnce(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(createClient().sendMailboxMessage(mailbox, message)).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not send a duplicate when the mailbox send result is uncertain after acceptance", async () => {
    let accepted = 0;
    const paths: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const path = new URL(input).pathname;
      paths.push(path);
      if (path === "/api/request_send_mail_access") return new Response('{"status":"ok"}');
      accepted += 1;
      return path === "/api/send_mail"
        ? new Response("Failed to send mail SMTP acknowledgement lost", { status: 400 })
        : new Response('{"status":"ok"}');
    }));
    await expect(createClient().sendMailboxMessage(mailbox, message)).rejects.toThrow("SMTP acknowledgement lost");
    expect(accepted).toBe(1);
    expect(paths).not.toContain("/admin/send_mail");
  });
});
