import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";

const mailtmProviderType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm",
  description: "Mail.tm provider",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["free"],
};

const mailtmInstance: ProviderInstance = {
  id: "mailtm_shared_default",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm Default",
  status: "active",
  runtimeKind: "external",
  connectorKind: "mailtm-client",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 100,
  connectionRef: "https://api.mail.tm",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const mailtmAdapter: MailProviderAdapter = {
  typeKey: "mailtm",
  async createMailboxSession({ request, instance, now }) {
    return {
      id: "mailbox_20260401000000_0001",
      hostId: request.hostId,
      providerTypeKey: "mailtm",
      providerInstanceId: instance.id,
      emailAddress: "plain@mail.tm",
      mailboxRef: "mailtm:demo",
      status: "open",
      createdAt: now.toISOString(),
      metadata: { ...(request.metadata ?? {}) },
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "MAILTM_OK",
      averageLatencyMs: 100,
    };
  },
};

const cloudflareProviderType: ProviderTypeDefinition = {
  key: "cloudflare_temp_email",
  displayName: "Cloudflare Temp Email",
  description: "Cloudflare Temp Email runtime",
  supportsDynamicProvisioning: true,
  defaultStrategyKey: "dynamic-priority",
  tags: ["runtime"],
};

const cloudflareInstance: ProviderInstance = {
  id: "cloudflare_temp_email_shared_default",
  providerTypeKey: "cloudflare_temp_email",
  displayName: "Cloudflare Temp Email",
  status: "active",
  runtimeKind: "cloudflare_temp_email-runtime",
  connectorKind: "cloudflare_temp_email-connector",
  shared: true,
  costTier: "paid",
  healthScore: 1,
  averageLatencyMs: 40,
  connectionRef: "https://temp.example.test",
  hostBindings: [],
  groupKeys: [],
  metadata: {
    baseUrl: "https://temp.example.test",
  },
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
};

const cloudflareAdapter: MailProviderAdapter = {
  typeKey: "cloudflare_temp_email",
  async createMailboxSession({ request, instance, now }) {
    const requestedDomain = request.requestedDomain ?? "pool.example.com";
    const selectedDomain = request.requestRandomSubdomain
      ? `rand.${requestedDomain}`
      : requestedDomain;
    return {
      id: "mailbox_20260401000000_0002",
      hostId: request.hostId,
      providerTypeKey: "cloudflare_temp_email",
      providerInstanceId: instance.id,
      emailAddress: `seed@${selectedDomain}`,
      mailboxRef: "cloudflare_temp_email:demo",
      status: "open",
      createdAt: now.toISOString(),
      metadata: { ...(request.metadata ?? {}) },
    };
  },
  async probeInstance() {
    return {
      ok: true,
      detail: "CLOUDFLARE_TEMP_EMAIL_OK",
      averageLatencyMs: 40,
    };
  },
};

describe("easy email random subdomain support", () => {
  it("rejects random subdomain requests for providers other than cloudflare_temp_email", () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [mailtmProviderType],
      providerInstances: [mailtmInstance],
      adapters: [mailtmAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(() => service.planMailbox({
      hostId: "demo-host",
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      requestRandomSubdomain: true,
    })).toThrowError(/does not support random subdomain mailbox creation/i);
  });

  it("persists requestedDomain, selectedDomain, and random-subdomain mode on opened sessions", async () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [cloudflareProviderType],
      providerInstances: [cloudflareInstance],
      adapters: [cloudflareAdapter],
    }, new Date("2026-04-01T00:00:00.000Z"));

    const result = await service.openMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      requestedDomain: "root.example.com",
      requestRandomSubdomain: true,
    }, new Date("2026-04-01T00:00:00.000Z"));

    expect(result.instance.providerTypeKey).toBe("cloudflare_temp_email");
    expect(result.session.emailAddress).toBe("seed@rand.root.example.com");
    expect(result.session.metadata).toMatchObject({
      requestedDomain: "root.example.com",
      selectedDomain: "rand.root.example.com",
      domainSelectionMode: "random-subdomain",
    });
  });
});
