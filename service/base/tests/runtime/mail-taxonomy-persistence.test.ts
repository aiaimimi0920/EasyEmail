import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("runtime mail taxonomy persistence", () => {
  it("reads an HTTP-created folder after a bundled-core style restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "easy-email-taxonomy-runtime-"));
    const apiKey = "runtime-taxonomy-test-token";
    const config = parseEasyEmailServiceRuntimeConfig({
      server: { host: "127.0.0.1", port: 0, apiKey },
      maintenance: { enabled: false },
      persistence: { enabled: true, driver: "file", intervalMs: 60_000 },
      providers: { enabledProviders: [] },
    }, { stateDir });
    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      const first = await startEasyEmailServiceRuntime({ config });
      let itemId = "";
      try {
        const created = await fetch(`${first.server.baseUrl}/mail/taxonomy/folder/restart_proof`, {
          method: "PUT",
          headers,
          body: JSON.stringify({ name: "Restart proof" }),
        });
        expect(created.status).toBe(200);
        itemId = ((await created.json()) as { item: { id: string } }).item.id;
      } finally {
        await first.close();
      }

      const relationalPath = join(stateDir, "state", "easy-email-relational.sqlite3");
      expect(existsSync(relationalPath)).toBe(true);

      const restarted = await startEasyEmailServiceRuntime({ config });
      try {
        const response = await fetch(
          `${restarted.server.baseUrl}/mail/taxonomy/${encodeURIComponent(itemId)}`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          item: { id: itemId, kind: "folder", name: "Restart proof", version: 1 },
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
