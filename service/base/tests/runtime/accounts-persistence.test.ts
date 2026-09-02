import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("runtime account persistence", () => {
  it("reads HTTP-created account metadata and opaque refs after restart", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "easy-email-account-runtime-"));
    const apiKey = "runtime-account-test-token";
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
      let accountId = "";
      try {
        const created = await fetch(`${first.server.baseUrl}/mail/accounts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            kind: "normal_long_lived",
            displayName: "Restart proof",
            primaryAddress: "restart-proof@example.test",
            credentialRefs: [{
              secretBackend: "fake-vault",
              secretKey: "ref:v1:restart-proof/imap",
              credentialKind: "imap_password",
              authMethod: "password",
            }],
          }),
        });
        expect(created.status).toBe(200);
        accountId = ((await created.json()) as { account: { id: string } }).account.id;
      } finally {
        await first.close();
      }

      const relationalPath = join(stateDir, "state", "easy-email-relational.sqlite3");
      expect(existsSync(relationalPath)).toBe(true);

      const restarted = await startEasyEmailServiceRuntime({ config });
      try {
        const response = await fetch(
          `${restarted.server.baseUrl}/mail/accounts/${encodeURIComponent(accountId)}`,
          { headers: { authorization: `Bearer ${apiKey}` } },
        );
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          account: {
            id: accountId,
            kind: "normal_long_lived",
            primaryAddress: "restart-proof@example.test",
            credentialRefs: [{
              secretKey: "ref:v1:restart-proof/imap",
              status: "missing",
            }],
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
