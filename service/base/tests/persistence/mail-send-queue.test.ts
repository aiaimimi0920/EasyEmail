import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { EasyEmailError } from "../../src/domain/errors.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { MailMessageService } from "../../src/service/mail-messages.js";
import { MailSendQueueService } from "../../src/service/mail-send-queue.js";

describe("mail send queue relational persistence and M5 invariants", () => {
  it("enforces idempotency, atomic lease claim, stale lease recovery, CAS protection, backoff, scheduled reopen, and restart persistence without storing secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-send-queue-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    const canarySecret = "smtp-queue-canary-secret-never-persisted";
    let currentNow = new Date("2026-11-22T03:00:00.000Z");
    const clock = () => currentNow;

    try {
      const db1 = new SqliteRelationalDatabase({ databasePath, now: clock });
      let firstQueueItemId = "";
      try {
        const accounts1 = new MailAccountService(db1, clock);
      const account = await accounts1.createAccount({
        kind: "normal_long_lived",
        displayName: "Work Sender",
        primaryAddress: "sender@example.com",
        imap: { host: "imap.example.com", port: 993, security: "tls", username: "sender@example.com" },
        smtp: { host: "smtp.example.com", port: 465, security: "tls", username: "sender@example.com" },
        credentialRefs: [
          {
            secretBackend: "windows_credential_manager",
            secretKey: "ref:v1:desktop/00000000000000000000000000000011",
            credentialKind: "imap_password",
            authMethod: "password",
          },
          {
            secretBackend: "windows_credential_manager",
            secretKey: "ref:v1:desktop/00000000000000000000000000000012",
            credentialKind: "smtp_password",
            authMethod: "password",
          },
        ],
      });
      expect(account.sendStatus).toBe("enabled");

      let nextBehavior: "ok" | "transient" | "auth" = "transient";
      const sendQueue1 = new MailSendQueueService(db1, clock, {
        accountRepository: db1,
        leaseDurationMs: 60_000,
        credentialResolver: {
          async resolveCredential(req) {
            expect(req.useCase).toBe("smtp-send");
            return { status: "resolved", secret: canarySecret };
          },
        },
        smtpTransport: {
          async testConnection() {
            return { authenticated: true, capabilitySummary: "AUTH PLAIN" };
          },
          async sendMessage(_profile, secret) {
            expect(secret).toBe(canarySecret);
            if (nextBehavior === "transient") {
              throw new EasyEmailError("SMTP_TRANSIENT_ERROR", `Temporary failure (${secret})`);
            }
            if (nextBehavior === "auth") {
              throw new EasyEmailError("SMTP_AUTH_FAILED", "Auth rejected");
            }
            return { providerMessageId: "<provider-msg-1@example.com>" };
          },
        },
      });

      const firstEnqueue = await sendQueue1.enqueueSend(
        {
          accountId: account.id,
          targetAddress: "target@example.com",
          ccAddresses: ["cc@example.com"],
          bccAddresses: ["bcc@example.com"],
          subject: "Idempotent dispatch",
          bodyText: "Hello queue",
          bodyHtml: '<p onclick="evil()">Hello queue</p><script>evil()</script>',
        },
        "idem-key-001",
      );
      expect(firstEnqueue.deduplicated).toBe(false);
      expect(firstEnqueue.queueItem.status).toBe("queued");

      const duplicateEnqueue = await sendQueue1.enqueueSend(
        {
          accountId: account.id,
          targetAddress: "target@example.com",
          ccAddresses: ["cc@example.com"],
          bccAddresses: ["bcc@example.com"],
          subject: "Idempotent dispatch",
          bodyText: "Hello queue",
          bodyHtml: '<p onclick="evil()">Hello queue</p><script>evil()</script>',
        },
        "idem-key-001",
      );
      expect(duplicateEnqueue.deduplicated).toBe(true);
      expect(duplicateEnqueue.queueItem.id).toBe(firstEnqueue.queueItem.id);

      await expect(
        sendQueue1.enqueueSend(
          {
            accountId: account.id,
            targetAddress: "different@example.com",
            subject: "Idempotent dispatch",
            bodyText: "Hello queue",
          },
          "idem-key-001",
        ),
      ).rejects.toMatchObject({ code: "SEND_IDEMPOTENCY_CONFLICT" });

      // Transient failure -> exponential backoff (60s)
      const firstRun = await sendQueue1.runOnce();
      expect(firstRun).toEqual({ processedCount: 1, sentCount: 0, retryCount: 1, failedCount: 0 });
      const backedOff = await sendQueue1.getSendQueueItem(firstEnqueue.queueItem.id);
      expect(backedOff.status).toBe("queued");
      expect(backedOff.attemptCount).toBe(1);
      expect(backedOff.nextRetryAt).toBe("2026-11-22T03:01:00.000Z");
      expect(JSON.stringify(backedOff)).not.toContain(canarySecret);

      // Scheduled send + pending marker + reopen into Drafts
      const scheduledEnqueue = await sendQueue1.enqueueSend({
        accountId: account.id,
        targetAddress: "future@example.com",
        ccAddresses: ["sched-cc@example.com"],
        bccAddresses: ["sched-bcc@example.com"],
        scheduledAt: "2026-11-22T05:00:00.000Z",
        subject: "Scheduled report",
        bodyText: "Pending scheduled body",
      });
      const messages1 = new MailMessageService(db1, clock, { accountRepository: db1 });
      const pendingList = await messages1.listMessages({
        scope: "normal_account",
        accountId: account.id,
        folder: "sent",
      });
      const pendingMsg = pendingList.messages.find((m) => m.id === scheduledEnqueue.messageId);
      expect(pendingMsg?.labels).toEqual(["未发送"]);

      const reopened = await sendQueue1.reopenScheduledSend(scheduledEnqueue.messageId);
      expect(reopened.queueItem.status).toBe("cancelled");
      expect(reopened.message.localFolder).toBe("drafts");
      expect(reopened.message.labels).toEqual([]);
      expect(reopened.message.draftCcAddresses).toEqual(["sched-cc@example.com"]);
      expect(reopened.message.draftBccAddresses).toEqual(["sched-bcc@example.com"]);

      // Simulate restart while backedOff becomes due, and test atomic claim + stale lease recovery + CAS!
      firstQueueItemId = firstEnqueue.queueItem.id;
      } finally {
        db1.close();
      }
      const rawSqliteBytes = await readFile(databasePath);
      expect(rawSqliteBytes.includes(Buffer.from(canarySecret, "utf8"))).toBe(false);

      currentNow = new Date("2026-11-22T03:01:05.000Z");
      const db2 = new SqliteRelationalDatabase({ databasePath, now: clock });
      try {
        // Worker A claims due item; Worker B attempts concurrent claim and gets undefined!
        const claimedByA = await db2.claimNextDueSend(
          "worker-A",
          "2026-11-22T03:02:05.000Z",
          currentNow.toISOString(),
        );
        const claimedByB = await db2.claimNextDueSend(
          "worker-B",
          "2026-11-22T03:02:05.000Z",
          currentNow.toISOString(),
        );
        expect(claimedByA?.queueItem.id).toBe(firstQueueItemId);
        expect(claimedByB).toBeUndefined();

        // Advance past Worker A's lease -> recoverStaleLeases moves it to delivery_unknown
        currentNow = new Date("2026-11-22T03:03:00.000Z");
        const recoveredCount = await db2.recoverStaleLeases(currentNow.toISOString());
        expect(recoveredCount).toBe(1);

        // Stale Worker A tries to mark sent after lease loss -> CAS rejects (returns undefined), preserving delivery_unknown!
        const staleCompletion = await db2.completeClaimedSendSent(
          firstQueueItemId,
          "worker-A",
          "<stale@example.com>",
          currentNow.toISOString(),
        );
        expect(staleCompletion).toBeUndefined();

        const sendQueue2 = new MailSendQueueService(db2, clock, {
          accountRepository: db2,
          credentialResolver: {
            async resolveCredential() {
              return { status: "resolved", secret: canarySecret };
            },
          },
          smtpTransport: {
            async testConnection() {
              return { authenticated: true, capabilitySummary: "OK" };
            },
            async sendMessage() {
              return { providerMessageId: "<delivered-after-confirm@example.com>" };
            },
          },
        });

        const recoveredItem = await sendQueue2.getSendQueueItem(firstQueueItemId);
        expect(recoveredItem.status).toBe("delivery_unknown");

        // Retrying delivery_unknown without explicit confirmation fails closed
        await expect(
          sendQueue2.retrySendQueueItem(recoveredItem.id),
        ).rejects.toMatchObject({ code: "SEND_DELIVERY_UNKNOWN_CONFIRMATION_REQUIRED" });

        // Explicit confirmation re-queues and delivers cleanly
        const retried = await sendQueue2.retrySendQueueItem(recoveredItem.id, {
          expectedVersion: recoveredItem.version,
          confirmDeliveryUnknown: true,
        });
        expect(retried.status).toBe("queued");

        const delivered = await sendQueue2.runItem(retried.id);
        expect(delivered.queueItem.status).toBe("sent");
        expect(delivered.queueItem.providerMessageId).toBe("<delivered-after-confirm@example.com>");
        expect(delivered.runResult).toEqual({
          processedCount: 1,
          sentCount: 1,
          retryCount: 0,
          failedCount: 0,
        });
      } finally {
        db2.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
