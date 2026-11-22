import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { NodeSmtpTransport } from "../../src/service/smtp-transport.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

interface SmtpServerHandle {
  port: number;
  getState(): {
    port: number;
    connections: number;
    authenticatedCount: number;
    rejectedCount: number;
    receivedMessages: Array<{ mailFrom: string; rcptTo: string[]; rawData: string }>;
  };
  close(): Promise<void>;
}

interface SmtpServerModule {
  startLoopbackTlsSmtpServer(options: {
    certPem: string;
    keyPem: string;
    expectedUsername: string;
    expectedPassword: string;
    mode?: "tls" | "starttls";
    authMethods?: string;
    dataResponseCode?: number;
    dataResponseMessage?: string;
    stallOnDataMs?: number;
  }): Promise<SmtpServerHandle>;
}

describe("NodeSmtpTransport over real loopback TLS 1.2+ and STARTTLS", () => {
  it("authenticates and delivers UTF-8 MIME messages over implicit TLS and STARTTLS without leaking Bcc or secrets", async () => {
    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { startLoopbackTlsSmtpServer } = (await import(
      pathToFileURL(resolve(fixturesDir, "loopback-tls-smtp-server.mjs")).href
    )) as SmtpServerModule;

    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
    const canarySecret = "smtp-tls-canary-secret-99";
    const tlsServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "sender@example.com",
      expectedPassword: canarySecret,
      mode: "tls",
    });
    const starttlsServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "sender@example.com",
      expectedPassword: canarySecret,
      mode: "starttls",
      authMethods: "LOGIN",
    });

    try {
      const transport = new NodeSmtpTransport({ timeoutMs: 5_000, tlsCa: certPem });

      const testResult = await transport.testConnection(
        {
          protocol: "smtp",
          host: "127.0.0.1",
          port: tlsServer.port,
          security: "tls",
          username: "sender@example.com",
        },
        canarySecret,
      );
      expect(testResult.authenticated).toBe(true);
      expect(testResult.capabilitySummary).toContain("AUTH PLAIN LOGIN");

      const sendResult = await transport.sendMessage(
        {
          protocol: "smtp",
          host: "127.0.0.1",
          port: starttlsServer.port,
          security: "starttls",
          username: "sender@example.com",
        },
        canarySecret,
        {
          fromAddress: "sender@example.com",
          fromName: "发件测试",
          toAddresses: ["to@example.com"],
          ccAddresses: ["cc@example.com"],
          bccAddresses: ["bcc@example.com"],
          subject: "中文主题测试",
          bodyText: ".leading dot line\nSecond line",
          bodyHtml: "<p>.leading dot line</p>",
        },
      );
      expect(sendResult.providerMessageId).toContain("fake-smtp-msg-1");

      const state = starttlsServer.getState();
      expect(state.authenticatedCount).toBe(1);
      expect(state.receivedMessages).toHaveLength(1);
      const delivered = state.receivedMessages[0]!;
      expect(delivered.mailFrom).toBe("<sender@example.com>");
      expect(delivered.rcptTo).toEqual(["<to@example.com>", "<cc@example.com>", "<bcc@example.com>"]);
      expect(delivered.rawData).toContain("To: <to@example.com>");
      expect(delivered.rawData).toContain("Cc: <cc@example.com>");
      expect(delivered.rawData).not.toContain("bcc@example.com");
      expect(delivered.rawData).toContain("=?UTF-8?B?");

      const wrongSecret = "wrong-canary-secret-never-echo";
      await expect(
        transport.testConnection(
          {
            protocol: "smtp",
            host: "127.0.0.1",
            port: tlsServer.port,
            security: "tls",
            username: "sender@example.com",
          },
          wrongSecret,
        ),
      ).rejects.toSatisfy((error: unknown) => {
        const record = error as { code?: string; message?: string };
        return record.code === "SMTP_AUTH_FAILED" && !JSON.stringify(record).includes(wrongSecret);
      });
    } finally {
      await tlsServer.close();
      await starttlsServer.close();
    }
  });

  it("classifies 4xx transient, 5xx permanent, and timeout SMTP failures deterministically", async () => {
    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { startLoopbackTlsSmtpServer } = (await import(
      pathToFileURL(resolve(fixturesDir, "loopback-tls-smtp-server.mjs")).href
    )) as SmtpServerModule;

    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();
    const transientServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "sender@example.com",
      expectedPassword: "pw",
      dataResponseCode: 451,
      dataResponseMessage: "4.3.0 Try again later",
    });
    const permanentServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "sender@example.com",
      expectedPassword: "pw",
      dataResponseCode: 550,
      dataResponseMessage: "5.1.1 Mailbox unavailable",
    });
    const timeoutServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "sender@example.com",
      expectedPassword: "pw",
      stallOnDataMs: 600,
    });

    const envelope = {
      fromAddress: "sender@example.com",
      toAddresses: ["to@example.com"],
      ccAddresses: [],
      bccAddresses: [],
      subject: "Classification test",
      bodyText: "Body",
    };

    try {
      const transport = new NodeSmtpTransport({ timeoutMs: 250, tlsCa: certPem });
      await expect(
        transport.sendMessage(
          { protocol: "smtp", host: "127.0.0.1", port: transientServer.port, security: "tls", username: "sender@example.com" },
          "pw",
          envelope,
        ),
      ).rejects.toMatchObject({ code: "SMTP_TRANSIENT_ERROR" });

      await expect(
        transport.sendMessage(
          { protocol: "smtp", host: "127.0.0.1", port: permanentServer.port, security: "tls", username: "sender@example.com" },
          "pw",
          envelope,
        ),
      ).rejects.toMatchObject({ code: "SMTP_PERMANENT_ERROR" });

      await expect(
        transport.sendMessage(
          { protocol: "smtp", host: "127.0.0.1", port: timeoutServer.port, security: "tls", username: "sender@example.com" },
          "pw",
          envelope,
        ),
      ).rejects.toMatchObject({ code: "SMTP_TIMEOUT" });
    } finally {
      await transientServer.close();
      await permanentServer.close();
      await timeoutServer.close();
    }
  });
});
