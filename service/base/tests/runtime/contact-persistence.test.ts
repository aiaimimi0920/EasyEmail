import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("runtime contact persistence", () => {
  it("reads an HTTP-created contact after a full bundled-core style restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "easy-email-contact-runtime-"));
    const apiKey = "runtime-contact-test-token";
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
      let contactId = "";
      try {
        const created = await fetch(`${first.server.baseUrl}/mail/contacts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            displayName: "Restart proof",
            emailAddress: "restart@example.test",
          }),
        });
        expect(created.status).toBe(200);
        contactId = ((await created.json()) as { contact: { id: string } }).contact.id;
      } finally {
        await first.close();
      }

      const relationalPath = join(stateDir, "state", "easy-email-relational.sqlite3");
      expect(existsSync(relationalPath)).toBe(true);
      expect(relationalPath).not.toBe(config.persistence.filePath);

      const restarted = await startEasyEmailServiceRuntime({ config });
      try {
        const response = await fetch(`${restarted.server.baseUrl}/mail/contacts/${contactId}`, {
          headers: { authorization: `Bearer ${apiKey}` },
        });
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          contact: {
            id: contactId,
            displayName: "Restart proof",
            emailAddress: "restart@example.test",
            version: 1,
          },
        });
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
