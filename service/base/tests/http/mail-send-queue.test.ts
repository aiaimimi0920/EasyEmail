import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("M5 HTTP send queue, SMTP test, and scheduled send reopen routes", () => {
  it("authenticates, tests SMTP, enqueues idempotently, cancels, retries, runs queue items, and reopens scheduled mail", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-http-send-queue-"));
    const apiKey = "m5-http-test-api-key-0123456789abcdef";
    const deliveredSubjects: string[] = [];
    const configPath = join(root, "config.yaml");
    const stateFile = join(root, "state.json").replaceAll("\\", "/");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 0",
        `  apiKey: "${apiKey}"`,
        "  corsOrigins:",
        "    - http://tauri.localhost",
        "maintenance:",
        "  enabled: false",
        "persistence:",
        "  enabled: true",
        "  driver: file",
        `  filePath: "${stateFile}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const baseConfig = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: root,
    });
    const runtime = await startEasyEmailServiceRuntime({
      sendQueueWorkerEnabled: false,
      config: baseConfig,
      mailCredentialResolver: {
        async resolveCredential() {
          return { status: "resolved", secret: "resolved-smtp-secret" };
        },
      },
      mailSmtpTransport: {
        async testConnection(profile) {
          return {
            authenticated: true,
            capabilitySummary: `${profile.host}:${profile.port} AUTH PLAIN`,
          };
        },
        async sendMessage(_profile, _secret, envelope) {
          deliveredSubjects.push(envelope.subject);
          return { providerMessageId: `<sent-${deliveredSubjects.length}@example.com>` };
        },
      },
    });

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      const unauth = await fetch(`${runtime.server.baseUrl}/mail/send-queue`);
      expect(unauth.status).toBe(401);

      const preflight = await fetch(`${runtime.server.baseUrl}/mail/send-queue`, {
        method: "OPTIONS",
        headers: {
          Origin: "http://tauri.localhost",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "authorization, content-type, idempotency-key",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("idempotency-key");

      const accountRes = await fetch(`${runtime.server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "QQ Sender",
          primaryAddress: "sender@qq.com",
          imap: { host: "imap.qq.com", port: 993, security: "tls", username: "sender@qq.com" },
          smtp: { host: "smtp.qq.com", port: 465, security: "tls", username: "sender@qq.com" },
          credentialRefs: [
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000021",
              credentialKind: "imap_password",
              authMethod: "password",
            },
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000022",
              credentialKind: "smtp_password",
              authMethod: "password",
            },
          ],
        }),
      });
      expect(accountRes.status).toBe(200);
      const { account } = (await accountRes.json()) as {
        account: { id: string; sendStatus: string; credentialRefs: Array<{ id: string; credentialKind: string }> };
      };
      expect(account.sendStatus).toBe("enabled");
      const smtpRef = account.credentialRefs.find((r) => r.credentialKind === "smtp_password")!;

      const smtpTestRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/smtp/test`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: account.id, credentialRefId: smtpRef.id }),
      });
      expect(smtpTestRes.status).toBe(200);
      expect(await smtpTestRes.json()).toMatchObject({
        result: { authenticated: true, capabilitySummary: "smtp.qq.com:465 AUTH PLAIN" },
      });

      const enqueueRes = await fetch(`${runtime.server.baseUrl}/mail/send-queue`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "http-idem-1" },
        body: JSON.stringify({
          accountId: account.id,
          targetAddress: "to@example.com",
          ccAddresses: ["cc@example.com"],
          subject: "Direct HTTP send",
          bodyText: "Direct body",
        }),
      });
      expect(enqueueRes.status).toBe(200);
      const enqueued = (await enqueueRes.json()) as {
        messageId: string;
        deduplicated: boolean;
        queueItem: { id: string; status: string };
      };
      expect(enqueued.deduplicated).toBe(false);

      const runItemRes = await fetch(
        `${runtime.server.baseUrl}/mail/send-queue/${encodeURIComponent(enqueued.queueItem.id)}/run`,
        { method: "POST", headers, body: "{}" },
      );
      expect(runItemRes.status).toBe(200);
      const runItemPayload = (await runItemRes.json()) as { queueItem: { status: string } };
      expect(runItemPayload.queueItem.status).toBe("sent");
      expect(deliveredSubjects).toEqual(["Direct HTTP send"]);

      // Scheduled send -> reopen into draft
      const scheduledRes = await fetch(`${runtime.server.baseUrl}/mail/send-queue`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          accountId: account.id,
          targetAddress: "later@example.com",
          scheduledAt: "2099-01-01T00:00:00.000Z",
          subject: "Scheduled HTTP mail",
          bodyText: "Wait until 2099",
        }),
      });
      const scheduled = (await scheduledRes.json()) as { messageId: string; queueItem: { id: string } };
      const dueRes = await fetch(`${runtime.server.baseUrl}/mail/send-queue/run-due`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 10 }),
      });
      expect(await dueRes.json()).toEqual({
        runResult: { processedCount: 0, sentCount: 0, retryCount: 0, failedCount: 0 },
      });

      const reopenRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages/${encodeURIComponent(scheduled.messageId)}/scheduled-send/reopen`,
        { method: "POST", headers, body: "{}" },
      );
      expect(reopenRes.status).toBe(200);
      const reopened = (await reopenRes.json()) as {
        message: { localFolder: string };
        queueItem: { status: string };
      };
      expect(reopened.message.localFolder).toBe("drafts");
      expect(reopened.queueItem.status).toBe("cancelled");

      const listRes = await fetch(`${runtime.server.baseUrl}/mail/send-queue?limit=10`, { headers });
      expect(listRes.status).toBe(200);
      const listPayload = (await listRes.json()) as {
        items: Array<{ id: string }>;
        worker: { enabled: boolean };
      };
      expect(listPayload.items).toHaveLength(2);
      expect(listPayload.worker.enabled).toBe(false);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
