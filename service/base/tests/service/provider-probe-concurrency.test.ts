import { describe, expect, it } from "vitest";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";


const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm",
  description: "Mail.tm provider",
  supportsDynamicProvisioning: true,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};


function createProviderInstance(index: number): ProviderInstance {
  const timestamp = "2026-07-25T00:00:00.000Z";
  return {
    id: `mailtm-${index}`,
    providerTypeKey: "mailtm",
    displayName: `Mail.tm ${index}`,
    status: "active",
    runtimeKind: "external",
    connectorKind: "mailtm-connector",
    shared: true,
    costTier: "free",
    healthScore: 1,
    averageLatencyMs: 100,
    connectionRef: "https://api.mail.tm",
    hostBindings: [],
    groupKeys: [],
    metadata: { apiBase: "https://api.mail.tm" },
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}


describe("provider probe concurrency", () => {
  it("limits probe-all to three simultaneous provider probes while preserving result order", async () => {
    const instances = Array.from({ length: 7 }, (_, index) => createProviderInstance(index + 1));
    let activeProbes = 0;
    let maxActiveProbes = 0;
    const service = createBootstrappedEasyEmailService({
      providerTypes: [providerType],
      providerInstances: instances,
      adapters: [{
        typeKey: "mailtm",
        createMailboxSession() { throw new Error("unused"); },
        async probeInstance() {
          activeProbes += 1;
          maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
          await new Promise((resolve) => setTimeout(resolve, 5));
          activeProbes -= 1;
          return { ok: true, averageLatencyMs: 5, detail: "MAILTM_OK" };
        },
      }],
    });

    const results = await service.probeAllProviderInstances(new Date("2026-07-25T00:00:00.000Z"));

    expect(maxActiveProbes).toBeLessThanOrEqual(3);
    expect(maxActiveProbes).toBe(3);
    expect(results.map((result) => result.instanceId)).toEqual(instances.map((instance) => instance.id));
  });
});
