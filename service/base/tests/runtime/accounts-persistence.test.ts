import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";
import type {
  MailCredentialResolver,
  MailImapConnectionTester,
} from "../../src/service/account-connectivity.js";

describe("runtime account persistence", () => {
  it("reads and resolves an HTTP-created opaque account ref after restart", async () => {
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
    const resolvedSecrets: string[] = [];
    const createConnectivity = (): {
      mailCredentialResolver: MailCredentialResolver;
      mailImapConnectionTester: MailImapConnectionTester;
    } => ({
      mailCredentialResolver: {
        async resolveCredential(request) {
          expect(request.useCase).toBe("imap-test");
          expect(request.credentialRef.ownerAccountId).toBe(request.account.id);
          expect(request.credentialRef.secretKey).toBe("ref:v1:restart-proof/imap");
          return { status: "resolved" as const, secret: "restart-resolution-canary" };
        },
      },
      mailImapConnectionTester: {
        async testConnection(profile, secret) {
          expect(profile).toMatchObject({
            host: "imap.restart-proof.example.test",
            username: "restart-proof@example.test",
          });
          resolvedSecrets.push(secret);
          return { authenticated: true as const, capabilitySummary: "IMAP4rev1 RESTART" };
        },
      },
    });

    try {
      const first = await startEasyEmailServiceRuntime({ config, ...createConnectivity() });
      let accountId = "";
      let credentialRefId = "";
      try {
        const created = await fetch(`${first.server.baseUrl}/mail/accounts`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            kind: "normal_long_lived",
            displayName: "Restart proof",
            primaryAddress: "restart-proof@example.test",
            imap: {
              host: "imap.restart-proof.example.test",
              port: 993,
              security: "tls",
              username: "restart-proof@example.test",
            },
            credentialRefs: [{
              secretBackend: "fake-vault",
              secretKey: "ref:v1:restart-proof/imap",
              credentialKind: "imap_password",
              authMethod: "password",
            }],
          }),
        });
        expect(created.status).toBe(200);
        const account = ((await created.json()) as {
          account: { id: string; credentialRefs: Array<{ id: string }> };
        }).account;
        accountId = account.id;
        credentialRefId = account.credentialRefs[0]!.id;
        const tested = await fetch(`${first.server.baseUrl}/mail/accounts/imap/test`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accountId, credentialRefId }),
        });
        expect(tested.status).toBe(200);
      } finally {
        await first.close();
      }

      const relationalPath = join(stateDir, "state", "easy-email-relational.sqlite3");
      expect(existsSync(relationalPath)).toBe(true);

      const restarted = await startEasyEmailServiceRuntime({ config, ...createConnectivity() });
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
            imap: {
              protocol: "imap",
              host: "imap.restart-proof.example.test",
              port: 993,
              security: "tls",
              username: "restart-proof@example.test",
            },
            credentialRefs: [{
              secretKey: "ref:v1:restart-proof/imap",
              status: "missing",
            }],
          },
        });
        const retested = await fetch(`${restarted.server.baseUrl}/mail/accounts/imap/test`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accountId, credentialRefId }),
        });
        expect(retested.status).toBe(200);
        await expect(retested.json()).resolves.toEqual({
          result: { authenticated: true, capabilitySummary: "IMAP4rev1 RESTART" },
        });
        expect(resolvedSecrets).toEqual([
          "restart-resolution-canary",
          "restart-resolution-canary",
        ]);
      } finally {
        await restarted.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
