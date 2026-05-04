import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../../src/domain/models.js";
import { CloudflareTempEmailConnectorAdapter } from "../../src/providers/cloudflare_temp_email/connector/index.js";
import {
  CloudflareTempEmailCreateClient,
  probeCloudflareTempEmailInstance,
} from "../../src/providers/cloudflare_temp_email/connector/client.js";

function createCloudflareInstance(): ProviderInstance {
  return {
    id: "cloudflare_temp_email_shared_default",
    providerTypeKey: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email",
    status: "active",
    runtimeKind: "cloudflare_temp_email-runtime",
    connectorKind: "cloudflare_temp_email-connector",
    shared: true,
    costTier: "paid",
    healthScore: 1,
    averageLatencyMs: 0,
    connectionRef: "https://temp.example.test",
    hostBindings: [],
    groupKeys: [],
    metadata: {
      baseUrl: "https://temp.example.test",
    },
    createdAt: "2026-04-01T00:00:00.000Z",
    updatedAt: "2026-04-01T00:00:00.000Z",
  };
}

describe("cloudflare temp email connector", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends requestedDomain and enableRandomSubdomain when random mode is requested", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"address":"demo@r4nd0m.root.example.com","jwt":"jwt-demo"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: ["pool.example.com"],
      randomSubdomainDomains: ["root.example.com"],
      timeoutSeconds: 30,
    });

    const mailbox = await client.newAddress("demo", {
      requestedDomain: "root.example.com",
      requestRandomSubdomain: true,
    });

    expect(mailbox).toEqual({
      address: "demo@r4nd0m.root.example.com",
      jwt: "jwt-demo",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/new_address",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({
          name: "demo",
          domain: "root.example.com",
          enableRandomSubdomain: true,
        }),
      }),
    );
  });

  it("captures randomSubdomainDomains metadata during runtime probe", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/health_check")) {
        return new Response("ok", { status: 200 });
      }

      return new Response(JSON.stringify({
        domains: ["pool.example.com", "mail.pool.example.com"],
        randomSubdomainDomains: ["root.example.com", "team.example.com"],
      }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const probe = await probeCloudflareTempEmailInstance(createCloudflareInstance());

    expect(probe.ok).toBe(true);
    expect(probe.metadata).toEqual({
      domains: "pool.example.com,mail.pool.example.com",
      domainsJson: JSON.stringify(["pool.example.com", "mail.pool.example.com"]),
      randomSubdomainDomains: "root.example.com,team.example.com",
      randomSubdomainDomainsJson: JSON.stringify(["root.example.com", "team.example.com"]),
    });
  });

  it("balances cloudflare temp email selection by root family instead of raw leaf-domain count", async () => {
    const randomSpy = vi.spyOn(Math, "random")
      .mockReturnValueOnce(0.7)
      .mockReturnValueOnce(0.0);
    const fetchMock = vi.fn(async () => {
      return new Response('{"address":"demo@gamma.family2.example.com","jwt":"jwt-demo"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: [
        "alpha.family1.example.com",
        "beta.family1.example.com",
        "delta.family1.example.com",
        "epsilon.family1.example.com",
        "gamma.family2.example.com",
      ],
      randomSubdomainDomains: [],
      timeoutSeconds: 30,
    });

    const mailbox = await client.newAddress("demo");

    expect(mailbox).toEqual({
      address: "demo@gamma.family2.example.com",
      jwt: "jwt-demo",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/new_address",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "demo",
          domain: "gamma.family2.example.com",
        }),
      }),
    );
    expect(randomSpy).toHaveBeenCalledTimes(2);
  });

  it("falls back to admin delegated sending when mailbox-token sending is blocked by balance", async () => {
    const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/api/request_send_mail_access")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      if (input.endsWith("/api/send_mail")) {
        return new Response("No balance", { status: 400 });
      }
      if (input.endsWith("/admin/send_mail")) {
        return new Response('{"status":"ok"}', { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      customAuth: "custom-auth",
      adminAuth: "admin-auth",
      domains: ["pool.example.com"],
      randomSubdomainDomains: ["root.example.com"],
      timeoutSeconds: 30,
    });

    const result = await client.sendMailboxMessage(
      {
        address: "sender@pool.example.com",
        jwt: "jwt-demo",
      },
      {
        toEmailAddress: "receiver@example.com",
        subject: "Verification code",
        textBody: "Your verification code is 112233.",
        fromName: "Matrix Sender",
      },
    );

    expect(result).toEqual({
      deliveryMode: "admin_delegate",
      detail: "mailbox_token_fallback_to_admin",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/send_mail",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-demo",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/admin/send_mail",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-custom-auth": "custom-auth",
          "x-admin-auth": "admin-auth",
        }),
      }),
    );
  });

  it("parses quoted-printable raw mail bodies before extracting alphabetic codes", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/api/mails?limit=20&offset=0")) {
        return new Response('{"results":[{"id":12,"source":"sender@example.com","subject":"Alphabetic verification sample"}]}', { status: 200 });
      }
      if (input.endsWith("/api/mail/12")) {
        return new Response(JSON.stringify({
          raw: [
            "Date: Tue, 28 Apr 2026 01:11:01 +0000",
            "Content-Type: multipart/alternative; boundary=\"demo-boundary\"",
            "",
            "--demo-boundary",
            "Content-Type: text/plain; charset=\"UTF-8\"",
            "Content-Transfer-Encoding: 7bit",
            "",
            "Use code QWERTY to continue.",
            "--demo-boundary",
            "Content-Type: text/html; charset=\"UTF-8\"",
            "Content-Transfer-Encoding: quoted-printable",
            "",
            "<html><body><p>Your code is <strong style=3D\"color:#1b6ef3\">QWERTY</strong>.</p></body></html>",
            "--demo-boundary--",
          ].join("\r\n"),
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: ["pool.example.com"],
      randomSubdomainDomains: ["root.example.com"],
      timeoutSeconds: 30,
    });

    const observed = await client.tryReadLatestCode(
      "session-1",
      { address: "demo@pool.example.com", jwt: "jwt-demo" },
      "cloudflare_temp_email_shared_default",
      "sender@example.com",
    );

    expect(observed).toMatchObject({
      extractedCode: "QWERTY",
      codeSource: "text",
      textBody: "Use code QWERTY to continue.",
    });
    expect(observed?.htmlBody).toContain("QWERTY");
  });

  it("falls back to parsed_mail content when raw mail bodies do not expose the verification code", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/api/mails?limit=20&offset=0")) {
        return new Response('{"results":[{"id":74,"source":"bounces@cf-bounce.tx-mail.aiaimimi.com","subject":"Delivery update"}]}', { status: 200 });
      }
      if (input.endsWith("/api/mail/74")) {
        return new Response(JSON.stringify({
          raw: [
            "Date: Tue, 28 Apr 2026 06:07:30 +0000",
            "Content-Type: multipart/report; boundary=\"bounce-boundary\"",
            "",
            "--bounce-boundary",
            "Content-Type: text/plain; charset=\"UTF-8\"",
            "",
            "Delivery notice only.",
            "--bounce-boundary--",
          ].join("\r\n"),
        }), { status: 200 });
      }
      if (input.endsWith("/api/parsed_mail/74")) {
        return new Response(JSON.stringify({
          sender: "bounces@cf-bounce.tx-mail.aiaimimi.com",
          subject: "Delivery update",
          text: "Your verification code is 556677.",
          html: "<html><body><p>Your verification code is <strong>556677</strong>.</p></body></html>",
        }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: ["pool.example.com"],
      randomSubdomainDomains: ["root.example.com"],
      timeoutSeconds: 30,
    });

    const observed = await client.tryReadLatestCode(
      "session-2",
      { address: "demo@pool.example.com", jwt: "jwt-demo" },
      "cloudflare_temp_email_shared_default",
    );

    expect(observed).toMatchObject({
      extractedCode: "556677",
      codeSource: "text",
      textBody: "Your verification code is 556677.",
    });
    expect(observed?.htmlBody).toContain("556677");
  });

  it("honors requestedLocalPart when opening a cloudflare temp mailbox session", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"address":"matrixsender@tx-mail.example.com","jwt":"jwt-demo"}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const adapter = new CloudflareTempEmailConnectorAdapter();
    const session = await adapter.createMailboxSession({
      request: {
        hostId: "matrix-host",
        providerTypeKey: "cloudflare_temp_email",
        provisionMode: "reuse-only",
        bindingMode: "shared-instance",
        requestedDomain: "tx-mail.example.com",
        requestedLocalPart: "matrixsender",
        metadata: {},
      },
      instance: createCloudflareInstance(),
      credentialSets: [],
      now: new Date("2026-04-30T00:00:00.000Z"),
    });

    expect(session.emailAddress).toBe("matrixsender@tx-mail.example.com");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/new_address",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "matrixsender",
          domain: "tx-mail.example.com",
        }),
      }),
    );
  });

  it("recovers an existing cloudflare temp mailbox session through admin jwt recovery", async () => {
    const fetchMock = vi.fn(async (input: string) => {
      if (input.endsWith("/admin/address?query=matrixsender%40tx-mail.example.com&limit=20&offset=0")) {
        return new Response('{"results":[{"id":77,"name":"matrixsender@tx-mail.example.com"}],"count":1}', { status: 200 });
      }
      if (input.endsWith("/admin/show_password/77")) {
        return new Response('{"jwt":"jwt-recovered"}', { status: 200 });
      }
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const instance = createCloudflareInstance();
    instance.metadata.adminAuth = "admin-auth";
    instance.metadata.customAuth = "custom-auth";

    const adapter = new CloudflareTempEmailConnectorAdapter();
    const recovered = await adapter.recoverMailboxSession?.({
      emailAddress: "matrixsender@tx-mail.example.com",
      hostId: "matrix-host",
      instance,
      credentialSets: [],
      now: new Date("2026-04-30T00:05:00.000Z"),
    });

    expect(recovered).toMatchObject({
      strategy: "session_restore",
      detail: "admin_jwt_recovery",
      session: {
        emailAddress: "matrixsender@tx-mail.example.com",
        providerInstanceId: "cloudflare_temp_email_shared_default",
      },
    });
    expect(recovered?.session.mailboxRef).toContain("jwt-recovered");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/admin/address?query=matrixsender%40tx-mail.example.com&limit=20&offset=0",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-custom-auth": "custom-auth",
          "x-admin-auth": "admin-auth",
        }),
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/admin/show_password/77",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "x-custom-auth": "custom-auth",
          "x-admin-auth": "admin-auth",
        }),
      }),
    );
  });
});
