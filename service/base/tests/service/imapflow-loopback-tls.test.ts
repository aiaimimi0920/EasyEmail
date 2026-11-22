import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ImapFlow } from "imapflow";
import { describe, expect, it } from "vitest";

import { ImapFlowConnectionTester } from "../../src/service/imapflow-connection-tester.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

interface LoopbackImapServerHandle {
  port: number;
  getState(): { port: number; connections: number; authenticatedCount: number; rejectedCount: number };
  close(): Promise<void>;
}

interface ServerModule {
  startLoopbackTlsImapServer(options: {
    certPem: string;
    keyPem: string;
    expectedUsername: string;
    expectedPassword: string;
  }): Promise<LoopbackImapServerHandle>;
}

describe("ImapFlowConnectionTester over real loopback TLS 1.2+", () => {
  it("authenticates against a real TLS 1.2+ loopback IMAP server and maps wrong credentials to IMAP_AUTH_FAILED", async () => {
    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { startLoopbackTlsImapServer } = (await import(
      pathToFileURL(resolve(fixturesDir, "loopback-tls-imap-server.mjs")).href
    )) as ServerModule;

    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
    const canarySecret = "tls-imap-canary-secret-42";
    const server = await startLoopbackTlsImapServer({
      certPem,
      keyPem,
      expectedUsername: "smoke@example.com",
      expectedPassword: canarySecret,
    });

    try {
      const tester = new ImapFlowConnectionTester({
        connectionTimeoutMs: 5_000,
        createClient: (options) =>
          new ImapFlow({
            ...options,
            tls: {
              ...options.tls,
              ca: certPem,
            },
          }),
      });

      const okResult = await tester.testConnection(
        {
          protocol: "imap",
          host: "127.0.0.1",
          port: server.port,
          security: "tls",
          username: "smoke@example.com",
        },
        canarySecret,
      );
      expect(okResult.authenticated).toBe(true);
      expect(okResult.capabilitySummary).toContain("IMAP4rev1");
      expect(server.getState().authenticatedCount).toBe(1);

      await expect(
        tester.testConnection(
          {
            protocol: "imap",
            host: "127.0.0.1",
            port: server.port,
            security: "tls",
            username: "smoke@example.com",
          },
          "wrong-password",
        ),
      ).rejects.toMatchObject({ code: "IMAP_AUTH_FAILED" });
      expect(server.getState().rejectedCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
