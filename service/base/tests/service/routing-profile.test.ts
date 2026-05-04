import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { encodeM2uMailboxRef } from "../../src/providers/m2u/client.js";
import { afterEach, describe, expect, it, vi } from "vitest";

const now = new Date("2026-04-25T00:00:00.000Z");

function createProviderType(
  key: ProviderTypeDefinition["key"],
  displayName: string,
): ProviderTypeDefinition {
  return {
    key,
    displayName,
    description: `${displayName} provider`,
    supportsDynamicProvisioning: false,
    defaultStrategyKey: "dynamic-priority",
    tags: ["external"],
  };
}

function createInstance(
  key: ProviderInstance["providerTypeKey"],
  overrides: Partial<ProviderInstance> = {},
): ProviderInstance {
  return {
    id: `${key}_shared_default`,
    providerTypeKey: key,
    displayName: `${key} default`,
    status: "active",
    runtimeKind: "external",
    connectorKind: `${key}-connector`,
    shared: true,
    costTier: "free",
    healthScore: 0.8,
    averageLatencyMs: 100,
    connectionRef: `external://${key}/default`,
    hostBindings: [],
    groupKeys: [],
    metadata: {},
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

describe("mail routing profiles", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("applies the high-availability health gate before availability scoring", () => {
    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
        createProviderType("moemail", "MoEmail"),
      ],
      providerInstances: [
        createInstance("m2u", {
          healthScore: 0.59,
          averageLatencyMs: 10,
        }),
        createInstance("moemail", {
          healthScore: 0.6,
          averageLatencyMs: 5000,
        }),
      ],
      routingProfiles: [
        {
          id: "high-availability",
          displayName: "High Availability",
          description: "Prefer only healthy providers.",
          providerStrategyModeId: "available-first",
          providerSelections: ["m2u", "moemail"],
          healthGate: {
            minimumHealthScore: 0.6,
          },
        },
      ],
    }, now);

    const plan = service.planMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerRoutingProfileId: "high-availability",
    }, now);

    expect(plan.instance.providerTypeKey).toBe("moemail");
  });

  it("lets available-first distribute first choice across healthy providers instead of locking the top score", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.95);

    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("cloudflare_temp_email", "Cloudflare Temp Email"),
        createProviderType("mailtm", "Mail.tm"),
      ],
      providerInstances: [
        createInstance("cloudflare_temp_email", {
          costTier: "paid",
          healthScore: 0.9,
          averageLatencyMs: 100,
          runtimeKind: "cloudflare_temp_email-runtime",
          connectorKind: "cloudflare_temp_email-connector",
          metadata: {
            baseUrl: "https://temp.example.test",
          },
          connectionRef: "https://temp.example.test",
        }),
        createInstance("mailtm", {
          healthScore: 0.8,
          averageLatencyMs: 120,
        }),
      ],
      routingProfiles: [
        {
          id: "broad-coverage",
          displayName: "Broad Coverage",
          description: "Distribute across healthy providers.",
          providerStrategyModeId: "available-first",
          providerSelections: ["cloudflare_temp_email", "mailtm"],
        },
      ],
    }, now);

    const plan = service.planMailbox({
      hostId: "demo-host",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
      providerRoutingProfileId: "broad-coverage",
    }, now);

    expect(plan.instance.providerTypeKey).toBe("mailtm");
  });

  it("can recover a persisted m2u session from the local email-address index", async () => {
    const m2uAdapter: MailProviderAdapter = {
      typeKey: "m2u",
      async createMailboxSession({ request, instance, now: openedAt }) {
        const mailbox = {
          email: "restorable@cpu.edu.kg",
          token: "token-123",
          viewToken: "view-456",
          mailboxId: "mailbox-1",
          expiresAt: "2026-04-25T01:00:00.000Z",
        };
        return {
          id: "mailbox_20260425000000_0001",
          hostId: request.hostId,
          providerTypeKey: "m2u",
          providerInstanceId: instance.id,
          emailAddress: mailbox.email,
          mailboxRef: encodeM2uMailboxRef(instance.id, mailbox),
          status: "open",
          createdAt: openedAt.toISOString(),
          expiresAt: mailbox.expiresAt,
          metadata: { ...(request.metadata ?? {}) },
        };
      },
      async probeInstance() {
        return {
          ok: true,
          detail: "M2U_OK",
          averageLatencyMs: 50,
        };
      },
    };

    const service = createBootstrappedEasyEmailService({
      providerTypes: [
        createProviderType("m2u", "MailToYou"),
      ],
      providerInstances: [
        createInstance("m2u"),
      ],
      adapters: [m2uAdapter],
    }, now);

    const opened = await service.openMailbox({
      hostId: "demo-host",
      providerTypeKey: "m2u",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, now);
    const recovered = await service.recoverMailboxSessionByEmailAddress({
      emailAddress: "restorable@cpu.edu.kg",
      providerTypeKey: "m2u",
      hostId: "demo-host",
    });

    expect(recovered).toBeDefined();
    expect(recovered.recovered).toBe(true);
    expect(recovered.strategy).toBe("session_restore");
    expect(recovered.session?.id).toBe(opened.session.id);
    expect(recovered.session?.mailboxRef).toBe(opened.session.mailboxRef);
  });
});
