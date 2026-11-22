import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";
import { ImapFlowTransport } from "../../src/service/imap-transport.js";
import { NodeSmtpTransport } from "../../src/service/smtp-transport.js";
import { startStatefulLoopbackTlsImapServer } from "../helpers/stateful-loopback-tls-imap-server.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

interface SmtpServerHandle {
  port: number;
  getState(): {
    receivedMessages: Array<{ mailFrom: string; rcptTo: string[]; rawData: string }>;
  };
  close(): Promise<void>;
}

interface SmtpModule {
  startLoopbackTlsSmtpServer(options: {
    certPem: string;
    keyPem: string;
    expectedUsername: string;
    expectedPassword: string;
    mode?: "tls" | "starttls";
  }): Promise<SmtpServerHandle>;
}

describe("M7B loopback TLS SMTP & IMAP Agent Mail E2E", () => {
  it("delivers tasks via M5 TLS SMTP, associates replies via M6 TLS IMAP, prevents cross-service hijack, and stays idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-http-agent-e2e-"));
    const apiKey = "m7b-e2e-test-api-key-0123456789abcdef";
    const agentImapSecret = "m7b-agent-imap-secret-9901";
    const agentSmtpSecret = "m7b-agent-smtp-secret-9902";

    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { startLoopbackTlsSmtpServer } = (await import(
      pathToFileURL(resolve(fixturesDir, "loopback-tls-smtp-server.mjs")).href
    )) as SmtpModule;
    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();

    const imapServer = await startStatefulLoopbackTlsImapServer({
      certPem,
      keyPem,
      expectedUsername: "bot-runner@agents.local",
      expectedPassword: agentImapSecret,
      folders: [
        { path: "INBOX", delimiter: "/", flags: ["\\HasNoChildren"], uidValidity: 101, uidNext: 1, messages: [] },
      ],
    });
    const smtpServer = await startLoopbackTlsSmtpServer({
      certPem,
      keyPem,
      expectedUsername: "bot-runner@agents.local",
      expectedPassword: agentSmtpSecret,
      mode: "tls",
    });

    const configPath = join(root, "config.yaml");
    const stateFile = join(root, "state.json").replaceAll("\\", "/");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 0",
        `  apiKey: "${apiKey}"`,
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
    const imapTransport = new ImapFlowTransport({ connectionTimeoutMs: 5_000, ca: certPem });
    const smtpTransport = new NodeSmtpTransport({ timeoutMs: 5_000, tlsCa: certPem });

    const runtime = await startEasyEmailServiceRuntime({
      sendQueueWorkerEnabled: false,
      config: baseConfig,
      mailImapTransport: imapTransport,
      mailImapConnectionTester: imapTransport,
      mailSmtpTransport: smtpTransport,
      mailCredentialResolver: {
        async resolveCredential(request) {
          if (request.credentialRef.credentialKind === "smtp_password") {
            return { status: "resolved", secret: agentSmtpSecret };
          }
          return { status: "resolved", secret: agentImapSecret };
        },
      },
    });

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      const agentAcctRes = await fetch(`${runtime.server.baseUrl}/mail/agent/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Agent Runner",
          emailAddress: "bot-runner@agents.local",
          imap: { host: "127.0.0.1", port: imapServer.port, security: "tls", username: "bot-runner@agents.local" },
          smtp: { host: "127.0.0.1", port: smtpServer.port, security: "tls", username: "bot-runner@agents.local" },
          credentialRefs: [
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000702",
              credentialKind: "imap_password",
              authMethod: "password",
            },
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000703",
              credentialKind: "smtp_password",
              authMethod: "password",
            },
          ],
        }),
      });
      expect(agentAcctRes.status).toBe(200);
      const { account: agentAccount } = (await agentAcctRes.json()) as { account: { id: string } };

      const createService = async (payload: Record<string, unknown>) => {
        const res = await fetch(`${runtime.server.baseUrl}/mail/agent/services`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { service: { id: string } };
        return body.service;
      };

      const plannerService = await createService({
        displayName: "Planner Bot",
        emailAddress: "planner@agents.example",
        trustLevel: "trusted",
        defaultSenderAccountId: agentAccount.id,
      });
      const restrictedService = await createService({
        displayName: "Restricted Ops Bot",
        emailAddress: "ops@agents.example",
        trustLevel: "restricted",
      });
      const blockedService = await createService({
        displayName: "Blocked Bot",
        emailAddress: "blocked@agents.example",
        trustLevel: "blocked",
      });

      const taskRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentServiceId: plannerService.id,
          senderAccountId: agentAccount.id,
          subject: "Summarize weekly release metrics",
          bodyText: "Please compile release metrics for M7B.",
          confirmRestricted: false,
        }),
      });
      expect(taskRes.status).toBe(200);
      const taskCreated = (await taskRes.json()) as {
        thread: { id: string };
        queueItem: { id: string };
      };

      // Deliver via M5 queue item run over TLS 1.2+ SMTP
      const runRes = await fetch(
        `${runtime.server.baseUrl}/mail/send-queue/${taskCreated.queueItem.id}/run`,
        { method: "POST", headers },
      );
      expect(runRes.status).toBe(200);
      const smtpMessages = smtpServer.getState().receivedMessages;
      expect(smtpMessages).toHaveLength(1);
      const messageIdMatch = smtpMessages[0]!.rawData.match(/^Message-ID:\s*(<[^\r\n>]+>)/imu);
      expect(messageIdMatch?.[1]).toBeTruthy();
      const transmittedRfcMessageId = messageIdMatch![1]!;

      const afterSendDetail = (await (
        await fetch(`${runtime.server.baseUrl}/mail/agent/threads/${taskCreated.thread.id}`, { headers })
      ).json()) as {
        detail: {
          thread: { status: string };
          messages: Array<{ direction: string; parsedStatus?: string }>;
        };
      };
      expect(afterSendDetail.detail.thread.status).toBe("awaiting_reply");
      expect(afterSendDetail.detail.messages).toEqual([
        expect.objectContaining({ direction: "outgoing", parsedStatus: "sent" }),
      ]);

      const inboxMessages = [
        // 1. Legitimate reply citing transmitted Message-ID from planner@agents.example
        {
          uid: 1,
          flags: [] as string[],
          subject: "Re: Summarize weekly release metrics",
          fromName: "Planner Bot",
          fromAddress: "planner@agents.example",
          messageId: "<reply-1@agents.example>",
          rawRfc822: [
            "Subject: Re: Summarize weekly release metrics",
            "From: Planner Bot <planner@agents.example>",
            "To: <bot-runner@agents.local>",
            "Message-ID: <reply-1@agents.example>",
            `In-Reply-To: ${transmittedRfcMessageId}`,
            `References: <root@agents.example> ${transmittedRfcMessageId}`,
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Metrics compiled: 100% green.",
          ].join("\r\n"),
        },
        // 2. Cross-service spoofed In-Reply-To from ops@agents.example -> must NOT hijack planner's thread
        {
          uid: 2,
          flags: [] as string[],
          subject: "Re: Hijack attempt",
          fromName: "Restricted Ops Bot",
          fromAddress: "ops@agents.example",
          messageId: "<spoof-2@agents.example>",
          rawRfc822: [
            "Subject: Re: Hijack attempt",
            "From: Restricted Ops Bot <ops@agents.example>",
            "To: <bot-runner@agents.local>",
            "Message-ID: <spoof-2@agents.example>",
            `In-Reply-To: ${transmittedRfcMessageId}`,
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Attempting to attach to another service's thread.",
          ].join("\r\n"),
        },
        // 3. Unmatched proactive alert from planner@agents.example -> needs_attention thread
        {
          uid: 3,
          flags: [] as string[],
          subject: "Unscheduled anomaly report",
          fromName: "Planner Bot",
          fromAddress: "planner@agents.example",
          messageId: "<unmatched-3@agents.example>",
          rawRfc822: [
            "Subject: Unscheduled anomaly report",
            "From: Planner Bot <planner@agents.example>",
            "To: <bot-runner@agents.local>",
            "Message-ID: <unmatched-3@agents.example>",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Proactive alert without prior task.",
          ].join("\r\n"),
        },
        // 4. Blocked service message -> ignored
        {
          uid: 4,
          flags: [] as string[],
          subject: "Blocked spam",
          fromName: "Blocked Bot",
          fromAddress: "blocked@agents.example",
          messageId: "<blocked-4@agents.example>",
          rawRfc822: [
            "Subject: Blocked spam",
            "From: Blocked Bot <blocked@agents.example>",
            "Message-ID: <blocked-4@agents.example>",
            `In-Reply-To: ${transmittedRfcMessageId}`,
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Ignored blocked sender.",
          ].join("\r\n"),
        },
        // 5. Unregistered external sender -> ignored
        {
          uid: 5,
          flags: [] as string[],
          subject: "Random external mail",
          fromName: "Stranger",
          fromAddress: "stranger@external.example",
          messageId: "<stranger-5@external.example>",
          rawRfc822: [
            "Subject: Random external mail",
            "From: Stranger <stranger@external.example>",
            "Message-ID: <stranger-5@external.example>",
            'Content-Type: text/plain; charset="utf-8"',
            "",
            "Should not create an agent thread.",
          ].join("\r\n"),
        },
      ];
      for (const message of inboxMessages) {
        imapServer.appendMessage("INBOX", message);
      }

      const syncRes = await fetch(
        `${runtime.server.baseUrl}/mail/accounts/${agentAccount.id}/sync`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      expect(syncRes.status).toBe(200);

      // Original planner thread transitioned to in_progress with [outgoing(sent), incoming(linked)]
      const linkedDetail = (await (
        await fetch(`${runtime.server.baseUrl}/mail/agent/threads/${taskCreated.thread.id}`, { headers })
      ).json()) as {
        detail: {
          thread: { status: string; lastIncomingMessageId?: string };
          messages: Array<{ direction: string; semanticRole: string; parsedStatus?: string }>;
        };
      };
      expect(linkedDetail.detail.thread.status).toBe("in_progress");
      expect(linkedDetail.detail.thread.lastIncomingMessageId).toBeTruthy();
      expect(linkedDetail.detail.messages).toEqual([
        expect.objectContaining({ direction: "outgoing", semanticRole: "task_request", parsedStatus: "sent" }),
        expect.objectContaining({ direction: "incoming", semanticRole: "agent_reply", parsedStatus: "linked" }),
      ]);

      // needs_attention threads: 1 for ops spoof + 1 for planner unmatched; 0 for blocked/stranger
      const needsAttentionRes = await fetch(
        `${runtime.server.baseUrl}/mail/agent/threads?status=needs_attention`,
        { headers },
      );
      const { threads: needsAttentionThreads } = (await needsAttentionRes.json()) as {
        threads: Array<{ agentServiceId: string }>;
      };
      expect(needsAttentionThreads).toHaveLength(2);
      expect(needsAttentionThreads.map((t) => t.agentServiceId).sort()).toEqual(
        [plannerService.id, restrictedService.id].sort(),
      );

      const blockedThreadsRes = await fetch(
        `${runtime.server.baseUrl}/mail/agent/threads?agentServiceId=${blockedService.id}`,
        { headers },
      );
      const { threads: blockedThreads } = (await blockedThreadsRes.json()) as { threads: unknown[] };
      expect(blockedThreads).toHaveLength(0);

      // Normal message list remains strictly isolated from Agent incoming & outgoing mail
      const normalMessagesAfterSync = (await (
        await fetch(`${runtime.server.baseUrl}/mail/messages`, { headers })
      ).json()) as { messages: unknown[] };
      expect(normalMessagesAfterSync.messages).toHaveLength(0);

      // Duplicate / UIDVALIDITY reset re-sync stays strictly idempotent
      imapServer.resetUidValidity("INBOX", 202, inboxMessages);
      const resyncRes = await fetch(
        `${runtime.server.baseUrl}/mail/accounts/${agentAccount.id}/sync`,
        { method: "POST", headers, body: JSON.stringify({}) },
      );
      expect(resyncRes.status).toBe(200);

      const allThreadsAfterResync = (await (
        await fetch(`${runtime.server.baseUrl}/mail/agent/threads`, { headers })
      ).json()) as { threads: unknown[] };
      expect(allThreadsAfterResync.threads).toHaveLength(3);

      const detailAfterResync = (await (
        await fetch(`${runtime.server.baseUrl}/mail/agent/threads/${taskCreated.thread.id}`, { headers })
      ).json()) as { detail: { messages: unknown[] } };
      expect(detailAfterResync.detail.messages).toHaveLength(2);
    } finally {
      await runtime.close();
      await imapServer.close();
      await smtpServer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
