import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTempEmailConnectorAdapter } from "../../src/providers/cloudflare_temp_email/connector/index.js";
import {
  CloudflareTempEmailCreateClient,
  encodeCloudflareTempMailboxRef,
} from "../../src/providers/cloudflare_temp_email/connector/client.js";
import { createCloudflareInstance } from "./cloudflare-temp-email-test-support.js";

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
        redirect: "error",
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

  it("lets the provider select its default after an auto-selected domain is rejected", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Invalid domain", { status: 400 }))
      .mockResolvedValueOnce(new Response('{"address":"demo@live.example.com","jwt":"jwt-demo"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: ["stale.example.com"],
      randomSubdomainDomains: [],
      timeoutSeconds: 30,
    });

    await expect(client.newAddress("demo")).resolves.toEqual({
      address: "demo@live.example.com",
      jwt: "jwt-demo",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://temp.example.test/api/new_address",
      expect.objectContaining({ body: JSON.stringify({ name: "demo", domain: "stale.example.com" }) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://temp.example.test/api/new_address",
      expect.objectContaining({ body: JSON.stringify({ name: "demo" }) }),
    );
  });

  it("keeps random-subdomain mode when falling back from a rejected auto-selected root", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Invalid domain", { status: 400 }))
      .mockResolvedValueOnce(new Response('{"address":"demo@random.live.example.com","jwt":"jwt-demo"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: [],
      randomSubdomainDomains: ["stale.example.com"],
      timeoutSeconds: 30,
    });

    await expect(client.newAddress("demo", { requestRandomSubdomain: true })).resolves.toEqual({
      address: "demo@random.live.example.com",
      jwt: "jwt-demo",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://temp.example.test/api/new_address",
      expect.objectContaining({
        body: JSON.stringify({
          name: "demo",
          domain: "stale.example.com",
          enableRandomSubdomain: true,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://temp.example.test/api/new_address",
      expect.objectContaining({
        body: JSON.stringify({ name: "demo", enableRandomSubdomain: true }),
      }),
    );
  });

  it("does not retry unrelated 400 failures after auto-selecting a domain", async () => {
    const fetchMock = vi.fn(async () => new Response("Human verification check failed", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: ["pool.example.com"],
      randomSubdomainDomains: [],
      timeoutSeconds: 30,
    });

    await expect(client.newAddress("demo")).rejects.toThrow(
      "Cloudflare Temp Email newAddress failed with status 400: Human verification check failed",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("deletes a mailbox through its bearer credential", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"success":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      customAuth: "custom-auth",
      domains: ["pool.example.com"],
      randomSubdomainDomains: [],
      timeoutSeconds: 30,
    });

    await expect(client.deleteMailbox({
      address: "demo@pool.example.com",
      jwt: "jwt-demo",
    })).resolves.toEqual({
      released: true,
      detail: "deleted",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/delete_address",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-demo",
          "x-custom-auth": "custom-auth",
        }),
        body: undefined,
      }),
    );
  });

  it("rejects a failed mailbox deletion without reporting a release", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      return new Response("delete disabled", { status: 403 });
    }));
    const client = new CloudflareTempEmailCreateClient({
      baseUrl: "https://temp.example.test",
      domains: [],
      randomSubdomainDomains: [],
      timeoutSeconds: 30,
    });

    await expect(client.deleteMailbox({
      address: "demo@pool.example.com",
      jwt: "jwt-demo",
    })).rejects.toThrow("Cloudflare Temp Email deleteAddress failed with status 403");
  });

  it("releases a cloudflare mailbox session through the provider adapter", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response('{"success":true}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const instance = createCloudflareInstance();
    const adapter = new CloudflareTempEmailConnectorAdapter();
    const result = await adapter.releaseMailboxSession?.({
      session: {
        id: "mailbox-release-1",
        hostId: "release-host",
        providerTypeKey: "cloudflare_temp_email",
        providerInstanceId: instance.id,
        emailAddress: "demo@pool.example.com",
        mailboxRef: encodeCloudflareTempMailboxRef(instance.id, {
          address: "demo@pool.example.com",
          jwt: "jwt-release",
        }),
        status: "open",
        createdAt: "2026-04-30T00:00:00.000Z",
        metadata: {},
      },
      instance,
      credentialSets: [],
      now: new Date("2026-04-30T00:10:00.000Z"),
      reason: "test-cleanup",
    });

    expect(result).toEqual({ released: true, detail: "deleted" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://temp.example.test/api/delete_address",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          Authorization: "Bearer jwt-release",
        }),
      }),
    );
  });

});
