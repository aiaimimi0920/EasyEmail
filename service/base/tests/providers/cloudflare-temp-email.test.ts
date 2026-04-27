import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../../src/domain/models.js";
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
});
