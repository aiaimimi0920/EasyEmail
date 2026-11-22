import { describe, expect, it } from "vitest";

import type {
  ObservedMessage,
  ProviderInstance,
  ProviderTypeDefinition,
} from "../../src/domain/models.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import { MailMessageService } from "../../src/service/mail-messages.js";
import { MailVerificationService } from "../../src/service/mail-verifications.js";

const INITIAL_NOW = new Date("2026-09-03T02:00:00.000Z");

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Verification test provider",
  description: "Deterministic provider for M4 verification polling tests",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm-verify-test",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm Verify Test",
  status: "active",
  runtimeKind: "external",
  connectorKind: "test",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 1,
  connectionRef: "test://verify",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: INITIAL_NOW.toISOString(),
  updatedAt: INITIAL_NOW.toISOString(),
};

describe("mail verification service", () => {
  it("extracts multi-candidate OTPs, tracks freshness, clears misclassified messages, and avoids re-reporting old codes on poll", async () => {
    let currentNow = new Date(INITIAL_NOW);
    const database = new SqliteRelationalDatabase({
      databasePath: ":memory:",
      now: () => currentNow,
    });

    try {
      let nextRemoteMessage: ObservedMessage | undefined;
      const adapter: MailProviderAdapter = {
        typeKey: "mailtm",
        async createMailboxSession({ request, instance, now }) {
          return {
            id: "ses_verify_poll_1",
            hostId: request.hostId,
            providerTypeKey: "mailtm",
            providerInstanceId: instance.id,
            emailAddress: "verify-poll@example.test",
            mailboxRef: "ref:verify-1",
            status: "open",
            createdAt: now.toISOString(),
            metadata: request.metadata ?? {},
          };
        },
        async syncMailboxCode() {
          return nextRemoteMessage;
        },
        async probeInstance() {
          return { ok: true, detail: "verify_test_ok", averageLatencyMs: 1 };
        },
      };

      const coreService = createBootstrappedEasyEmailService(
        {
          providerTypes: [providerType],
          providerInstances: [providerInstance],
          adapters: [adapter],
        },
        INITIAL_NOW,
      );

      const opened = await coreService.openMailbox(
        {
          hostId: "desktop-host",
          providerTypeKey: "mailtm",
          provisionMode: "reuse-only",
          bindingMode: "shared-instance",
          metadata: { targetService: "github" },
        },
        INITIAL_NOW,
      );

      const verifications = new MailVerificationService(
        database,
        database,
        () => currentNow,
        { easyEmailService: coreService },
      );
      const messages = new MailMessageService(
        database,
        () => currentNow,
        {
          accountRepository: database,
          easyEmailService: coreService,
          verificationService: verifications,
        },
      );
      verifications.setBeforeQueryHook(async () => {
        await messages.ingestObservedMessages();
      });

      const multiCandidateMsg = await messages.ingestExternalMessage({
        sourceKind: "temporary_session",
        sourceRefId: opened.session.id,
        sessionId: opened.session.id,
        receivedAddress: opened.session.emailAddress,
        providerLabel: "Mail.tm Verify Test",
        lifecycleState: "active",
        subject: "GitHub verification code 482910",
        sender: "GitHub <noreply@github.com>",
        bodyText: "Your verification code is 482910 (secondary security code 918273). Valid for 5 minutes.",
        observedAt: "2026-09-03T02:00:00.000Z",
      });

      const recentFresh = await verifications.listVerifications({ freshOnly: true });
      expect(recentFresh).toHaveLength(1);
      expect(recentFresh[0]).toMatchObject({
        messageId: multiCandidateMsg.messageId,
        code: "482910",
        codeSource: "subject",
        issuerHint: "GitHub",
        targetServiceHint: "github",
        isFresh: true,
        expiresAt: "2026-09-03T02:05:00.000Z",
      });
      expect(recentFresh[0]?.candidates).toEqual(expect.arrayContaining(["482910", "918273"]));

      currentNow = new Date("2026-09-03T02:06:00.000Z");
      expect(await verifications.listVerifications({ freshOnly: true })).toEqual([]);
      const historyAll = await verifications.listVerifications({ freshOnly: false });
      expect(historyAll[0]?.isFresh).toBe(false);

      const pollWithoutNewMail = await verifications.pollMailboxVerification(opened.session.id);
      expect(pollWithoutNewMail.refresh.insertedCount).toBe(0);
      expect(pollWithoutNewMail.detectedCode).toBeUndefined();

      currentNow = new Date("2026-09-03T02:07:00.000Z");
      nextRemoteMessage = {
        id: "obs_verify_new_2",
        sessionId: opened.session.id,
        providerInstanceId: providerInstance.id,
        observedAt: "2026-09-03T02:07:00.000Z",
        sender: "GitHub <noreply@github.com>",
        subject: "Your new sign-in code",
        textBody: "Enter verification code 774411 within 10 minutes.",
        extractedCode: "774411",
        extractedCandidates: ["774411"],
        codeSource: "text",
      };
      const pollWithNewMail = await verifications.pollMailboxVerification(opened.session.id);
      expect(pollWithNewMail.refresh.insertedCount).toBe(1);
      expect(pollWithNewMail.detectedCode).toMatchObject({
        code: "774411",
        sessionId: opened.session.id,
        isFresh: true,
      });

      await expect(verifications.pollMailboxVerification("ses_missing")).rejects.toMatchObject({
        code: "MAILBOX_SESSION_NOT_FOUND",
      });

      const noCodeMsg = await messages.ingestExternalMessage({
        sourceKind: "temporary_session",
        sourceRefId: opened.session.id,
        sessionId: opened.session.id,
        receivedAddress: opened.session.emailAddress,
        providerLabel: "Mail.tm Verify Test",
        lifecycleState: "active",
        subject: "Monthly newsletter update",
        sender: "news@example.com",
        bodyText: "Welcome to our autumn product roundup with zero passcodes.",
        classification: "verification",
        observedAt: "2026-09-03T02:08:00.000Z",
      });
      const reclassified = await verifications.reclassifyMessage(noCodeMsg.messageId);
      expect(reclassified).toBeUndefined();
      const updatedNoCodeDetail = await messages.getMessageDetail(noCodeMsg.messageId);
      expect(updatedNoCodeDetail.classification).toBe("general");
    } finally {
      database.close();
    }
  });
});
