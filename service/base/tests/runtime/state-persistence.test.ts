import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { EasyEmailSnapshot, RuntimeTemplate } from "../../src/domain/models.js";
import { EASY_EMAIL_HTTP_ROUTES } from "../../src/http/contracts.js";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";


describe("service runtime state preservation", () => {
  it("restores a persisted runtime template after a full restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "easy-email-state-preservation-"));
    const config = parseEasyEmailServiceRuntimeConfig({
      server: {
        host: "127.0.0.1",
        port: 0,
      },
      maintenance: {
        enabled: false,
      },
      persistence: {
        enabled: true,
        driver: "file",
        intervalMs: 60_000,
      },
      providers: {
        enabledProviders: [],
      },
    }, { stateDir });
    const template: RuntimeTemplate = {
      id: "state-preservation-template",
      providerTypeKey: "cloudflare_temp_email",
      displayName: "State Preservation Template",
      description: "Persists across a candidate runtime restart.",
      roleKey: "state-preservation",
      sharedByDefault: true,
      metadata: {
        releaseCandidate: "true",
      },
    };

    try {
      const firstRuntime = await startEasyEmailServiceRuntime({ config });
      try {
        firstRuntime.service.saveRuntimeTemplate(template);
        await firstRuntime.persistenceLoop?.flush();
      } finally {
        await firstRuntime.close();
      }

      const restartedRuntime = await startEasyEmailServiceRuntime({ config });
      try {
        const response = await fetch(
          `${restartedRuntime.server.baseUrl}${EASY_EMAIL_HTTP_ROUTES.snapshot}`,
        );
        expect(response.status).toBe(200);
        const payload = await response.json() as { snapshot: EasyEmailSnapshot };
        expect(payload.snapshot.runtimeTemplates).toContainEqual(template);
      } finally {
        await restartedRuntime.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
