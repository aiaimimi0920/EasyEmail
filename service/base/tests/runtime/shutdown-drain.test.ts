import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { EasyEmailSnapshot, ProviderHealthProbeResult, RuntimeTemplate } from "../../src/domain/models.js";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startMailMaintenanceLoop } from "../../src/runtime/maintenance-loop.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import { EasyEmailService } from "../../src/service/easy-email-service.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const template: RuntimeTemplate = {
  id: "during-shutdown", providerTypeKey: "cloudflare_temp_email", displayName: "Shutdown test",
  description: "Local fixture", roleKey: "test", sharedByDefault: false, metadata: {},
};

describe("runtime shutdown drain", () => {
  it("persists the last in-flight maintenance probe update", async () => {
    const release = deferred<void>();
    const snapshots: EasyEmailSnapshot[] = [];
    const probe = vi.spyOn(EasyEmailService.prototype, "probeAllProviderInstances").mockImplementation(async function () {
      await release.promise;
      this.saveRuntimeTemplate(template);
      return [];
    });
    const runtime = await startEasyEmailServiceRuntime({
      config: parseEasyEmailServiceRuntimeConfig({
        server: { host: "127.0.0.1", port: 0 },
        maintenance: { enabled: true, intervalMs: 60_000, activeProbeEnabled: false },
        persistence: { enabled: false, intervalMs: 60_000 }, providers: { enabledProviders: [] },
      }),
      stateStore: {
        async loadSeed() { return undefined; },
        async saveSnapshot(value) { snapshots.push(structuredClone(value)); },
      },
    });
    try {
      const closing = runtime.close();
      await delay(20);
      expect(snapshots).toHaveLength(1);
      release.resolve();
      await closing;
      expect(snapshots.at(-1)?.runtimeTemplates).toContainEqual(template);
    } finally {
      release.resolve();
      await runtime.close();
      probe.mockRestore();
    }
  });

  it("waits for disconnected HTTP work before the final snapshot and closes only once", async () => {
    const snapshots: EasyEmailSnapshot[] = [];
    const runtime = await startEasyEmailServiceRuntime({
      config: parseEasyEmailServiceRuntimeConfig({
        server: { host: "127.0.0.1", port: 0 }, maintenance: { enabled: false },
        persistence: { enabled: false, intervalMs: 60_000 }, providers: { enabledProviders: [] },
      }),
      stateStore: {
        async loadSeed() { return undefined; },
        async saveSnapshot(value) { snapshots.push(structuredClone(value)); },
      },
    });
    const entered = deferred<void>();
    const release = deferred<void>();
    vi.spyOn(runtime.handler, "queryObservedMessages").mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      runtime.service.saveRuntimeTemplate(template);
      return { messages: [] };
    });
    const controller = new AbortController();
    const request = fetch(`${runtime.server.baseUrl}/mail/query/observed-messages`, {
      signal: controller.signal,
    }).catch(() => undefined);
    try {
      await entered.promise;
      controller.abort();
      await request;
      let closed = false;
      const closing = runtime.close().then(() => { closed = true; });
      await delay(30);
      expect(closed).toBe(false);
      expect(snapshots).toHaveLength(1);
      release.resolve();
      await closing;
      expect(snapshots.at(-1)?.runtimeTemplates).toContainEqual(template);
      expect(snapshots).toHaveLength(2);
      await runtime.close();
      expect(snapshots).toHaveLength(2);
    } finally {
      release.resolve();
      await runtime.close();
    }
  });

  it("stops scheduling, drains the in-flight probe, and rejects manual work after stop", async () => {
    const service = createBootstrappedEasyEmailService();
    const pending = deferred<ProviderHealthProbeResult[]>();
    const probe = vi.spyOn(service, "probeAllProviderInstances").mockReturnValue(pending.promise);
    const loop = startMailMaintenanceLoop(service, {
      intervalMs: 60_000, keepRecentCount: 5, keepRecentSessionCount: 5,
      activeProbeEnabled: true, activeProbeIntervalMs: 60_000,
    });
    let stopped = false;
    const stopping = Promise.resolve(loop.stop()).then(() => { stopped = true; });
    try {
      await delay(20);
      expect(stopped).toBe(false);
      pending.resolve([]);
      await stopping;
      await expect(loop.probeAll()).rejects.toThrow("MAIL_MAINTENANCE_STOPPED");
      expect(() => loop.tick()).toThrow("MAIL_MAINTENANCE_STOPPED");
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      pending.resolve([]);
      await loop.stop();
    }
  });
});
