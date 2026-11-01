import { describe, expect, it } from "vitest";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import type { MailProviderAdapter, ProviderProbeResult } from "../../src/providers/contracts.js";

function fixture(probe: ProviderProbeResult) {
  const adapter: MailProviderAdapter = {
    typeKey: "temporam",
    createMailboxSession() { throw new Error("unused"); },
    probeInstance() { return probe; },
  };
  const service = createBootstrappedEasyEmailService({ adapters: [adapter] });
  const instance = service.getSnapshot().instances.find((value) => value.providerTypeKey === "temporam")!;
  service.saveProviderInstance({ ...instance, metadata: { ...instance.metadata, errorClass: "configuration", state: "missing-api-key", apiKey: "fixture-key" } });
  return { service, instance };
}

describe("provider probe diagnostic recovery", () => {
  it("clears a previous error class only after a successful probe", async () => {
    const { service, instance } = fixture({ ok: true, detail: "ok", averageLatencyMs: 1, metadata: { state: "ok" } });
    await service.probeProviderInstance(instance.id);
    const current = service.getSnapshot().instances.find((value) => value.id === instance.id)!;
    expect(current.metadata.errorClass).toBeUndefined();
    expect(current.metadata).toMatchObject({ state: "ok", apiKey: "fixture-key" });
  });

  it("retains the latest error classification on failure", async () => {
    const { service, instance } = fixture({ ok: false, detail: "failed", averageLatencyMs: 1, metadata: { errorClass: "network" } });
    await service.probeProviderInstance(instance.id);
    expect(service.getSnapshot().instances.find((value) => value.id === instance.id)?.metadata.errorClass).toBe("network");
  });
});
