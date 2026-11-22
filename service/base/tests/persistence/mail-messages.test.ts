import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { MailMessageService } from "../../src/service/mail-messages.js";
import { MailVerificationService } from "../../src/service/mail-verifications.js";

describe("mail message relational persistence and M4 invariants", () => {
  it("deduplicates cross-source RFC Message-IDs without merging across agent scope, decodes MIME headers, sanitizes HTML, and paginates", async () => {
    const database = new SqliteRelationalDatabase({
      databasePath: ":memory:",
      now: () => new Date("2026-09-03T00:00:00.000Z"),
    });

    try {
      const accounts = new MailAccountService(database, () => new Date("2026-09-03T00:00:00.000Z"));
      const workAccount = await accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "Work",
        primaryAddress: "work@example.com",
      });
      const agentAccount = await accounts.createAccount({
        kind: "agent_owned",
        scope: "agent",
        displayName: "Agent Bot",
        primaryAddress: "agent@example.com",
      });

      const verifications = new MailVerificationService(
        database,
        database,
        () => new Date("2026-09-03T00:05:00.000Z"),
      );
      const messages = new MailMessageService(
        database,
        () => new Date("2026-09-03T00:05:00.000Z"),
        { accountRepository: database, verificationService: verifications },
      );

      const first = await messages.ingestExternalMessage({
        rfcMessageId: "<shared-rfc-1@example.com>",
        sourceKind: "imap",
        sourceRefId: `imap:${workAccount.id}:inbox`,
        accountId: workAccount.id,
        externalMessageId: "uid-101",
        receivedAddress: "work@example.com",
        providerLabel: "Example IMAP",
        subject: "=?UTF-8?B?5qyi6L+O5L2/55So?= EasyEmail",
        sender: "=?UTF-8?Q?Security_Team?= <security@example.com>",
        bodyText: "Large body ".repeat(18_000),
        bodyHtml:
          '<div onclick="alert(1)"><p>Safe text</p><script>evil()</script><a href="javascript:alert(2)">Bad</a><a href="https://example.com/ok">Good</a></div>',
        observedAt: "2026-09-03T00:02:00.000Z",
      });

      const duplicateSameSource = await messages.ingestExternalMessage({
        rfcMessageId: "<shared-rfc-1@example.com>",
        sourceKind: "imap",
        sourceRefId: `imap:${workAccount.id}:inbox`,
        accountId: workAccount.id,
        externalMessageId: "uid-101",
        receivedAddress: "work@example.com",
        providerLabel: "Example IMAP",
        subject: "Ignored duplicate",
        sender: "security@example.com",
        observedAt: "2026-09-03T00:02:00.000Z",
      });
      expect(duplicateSameSource.messageId).toBe(first.messageId);

      const crossFolderSameRfc = await messages.ingestExternalMessage({
        rfcMessageId: "<SHARED-RFC-1@example.com>",
        sourceKind: "imap",
        sourceRefId: `imap:${workAccount.id}:all-mail`,
        accountId: workAccount.id,
        externalMessageId: "uid-999",
        receivedAddress: "work@example.com",
        providerLabel: "Example IMAP",
        subject: "=?UTF-8?B?5qyi6L+O5L2/55So?= EasyEmail",
        sender: "security@example.com",
        observedAt: "2026-09-03T00:02:00.000Z",
      });
      expect(crossFolderSameRfc.messageId).toBe(first.messageId);

      const agentCopy = await messages.ingestExternalMessage({
        rfcMessageId: "<shared-rfc-1@example.com>",
        sourceKind: "agent",
        sourceRefId: `agent:${agentAccount.id}`,
        accountId: agentAccount.id,
        externalMessageId: "agent-uid-1",
        receivedAddress: "agent@example.com",
        providerLabel: "Agent Relay",
        subject: "Agent isolated copy",
        sender: "runner@example.com",
        bodyText: "Agent payload",
        observedAt: "2026-09-03T00:03:00.000Z",
      });
      expect(agentCopy.messageId).not.toBe(first.messageId);

      const secondWork = await messages.ingestExternalMessage({
        sourceKind: "imap",
        sourceRefId: `imap:${workAccount.id}:inbox`,
        accountId: workAccount.id,
        externalMessageId: "uid-102",
        receivedAddress: "work@example.com",
        providerLabel: "Example IMAP",
        subject: "Second work message",
        sender: "colleague@example.com",
        bodyText: "Follow-up note",
        observedAt: "2026-09-03T00:04:00.000Z",
      });

      const page1 = await messages.listMessages({
        scope: "normal_account",
        accountId: workAccount.id,
        limit: 1,
      });
      expect(page1.messages).toHaveLength(1);
      expect(page1.messages[0]?.id).toBe(secondWork.messageId);
      expect("bodyText" in (page1.messages[0] as unknown as Record<string, unknown>)).toBe(false);
      expect("bodyHtml" in (page1.messages[0] as unknown as Record<string, unknown>)).toBe(false);
      expect(page1.nextCursor).toBeTruthy();

      await expect(
        messages.listMessages({ scope: "all", cursor: page1.nextCursor }),
      ).rejects.toMatchObject({ code: "INVALID_MAIL_MESSAGE_CURSOR" });

      const page2 = await messages.listMessages({
        scope: "normal_account",
        accountId: workAccount.id,
        limit: 1,
        cursor: page1.nextCursor,
      });
      expect(page2.messages.map((item) => item.id)).toEqual([first.messageId]);
      expect(page2.messages[0]?.subject).toBe("欢迎使用 EasyEmail");
      expect(page2.messages[0]?.fromName).toBe("Security Team");
      expect(page2.nextCursor).toBeUndefined();

      const sanitizedDetail = await messages.getMessageDetail(first.messageId);
      expect(sanitizedDetail.bodyText?.length).toBeGreaterThan(180_000);
      expect(sanitizedDetail.rawHtmlAvailable).toBe(true);
      expect(sanitizedDetail.rawBodyHtml).toBeUndefined();
      expect(sanitizedDetail.bodyHtml).toContain("<p>Safe text</p>");
      expect(sanitizedDetail.bodyHtml).toContain('href="https://example.com/ok"');
      expect(sanitizedDetail.bodyHtml).not.toContain("<script");
      expect(sanitizedDetail.bodyHtml).not.toContain("onclick");
      expect(sanitizedDetail.bodyHtml).not.toContain("javascript:");

      const rawDetail = await messages.getMessageDetail(first.messageId, { includeRawHtml: true });
      expect(rawDetail.rawBodyHtml).toContain("<script>evil()</script>");

      await expect(messages.getMessageDetail(agentCopy.messageId)).rejects.toMatchObject({
        code: "MAIL_MESSAGE_NOT_FOUND",
      });
      const agentDetail = await messages.getMessageDetail(agentCopy.messageId, { scope: "agent" });
      expect(agentDetail.subject).toBe("Agent isolated copy");
    } finally {
      database.close();
    }
  });

  it("persists canonical drafts, local actions, and temporary session promotion across SQLite restarts without copying messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-m4-messages-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");

    try {
      const db1 = new SqliteRelationalDatabase({
        databasePath,
        now: () => new Date("2026-09-03T01:00:00.000Z"),
      });
      const accounts1 = new MailAccountService(db1, () => new Date("2026-09-03T01:00:00.000Z"));
      const work = await accounts1.createAccount({
        kind: "normal_long_lived",
        displayName: "Work",
        primaryAddress: "work@example.com",
      });
      const other = await accounts1.createAccount({
        kind: "normal_long_lived",
        displayName: "Other",
        primaryAddress: "other@example.com",
      });

      const messages1 = new MailMessageService(db1, () => new Date("2026-09-03T01:05:00.000Z"), {
        accountRepository: db1,
      });

      await expect(
        messages1.saveLocalDraft({
          accountId: "acct_anonymous_virtual",
          subject: "Unsupported",
        }),
      ).rejects.toMatchObject({ code: "MAIL_DRAFT_ACCOUNT_UNSUPPORTED" });

      const savedDraft = await messages1.saveLocalDraft({
        accountId: work.id,
        targetAddress: "alice@example.com",
        ccAddresses: ["bob@example.com", "BOB@example.com"],
        bccAddresses: ["audit@example.com"],
        subject: "Initial proposal",
        bodyText: "Draft text v1",
        bodyHtml: '<p>Draft html</p><script>steal()</script>',
      });
      expect(savedDraft.version).toBe(1);

      await expect(
        messages1.saveLocalDraft({
          draftId: savedDraft.messageId,
          accountId: other.id,
          subject: "Cross-account hijack",
        }),
      ).rejects.toMatchObject({ code: "MAIL_DRAFT_CONFLICT" });

      const updatedDraft = await messages1.saveLocalDraft({
        draftId: savedDraft.messageId,
        accountId: work.id,
        targetAddress: "alice@example.com",
        ccAddresses: ["bob@example.com"],
        bccAddresses: [],
        subject: "Updated proposal",
        bodyText: "Draft text v2",
        bodyHtml: "<p>Draft html v2</p>",
      });
      expect(updatedDraft.messageId).toBe(savedDraft.messageId);
      expect(updatedDraft.version).toBe(2);

      const tempIngested = await messages1.ingestExternalMessage({
        messageId: "msg_temp_promote_1",
        sourceKind: "temporary_session",
        sourceRefId: "ses_promote_1",
        sessionId: "ses_promote_1",
        providerInstanceId: "mailtm-default",
        externalMessageId: "ext_temp_1",
        receivedAddress: "temp1@example.test",
        providerLabel: "Mail.tm",
        lifecycleState: "active",
        subject: "Temporary welcome",
        sender: "service@example.test",
        bodyText: "Keep history across promotion",
        observedAt: "2026-09-03T01:03:00.000Z",
      });

      await messages1.setLocalFlag(tempIngested.messageId, { flagName: "starred", enabled: true });
      await messages1.setLocalLabel(tempIngested.messageId, { labelName: "Onboarding", enabled: true });

      const anonBefore = await messages1.listMessages({ scope: "anonymous" });
      expect(anonBefore.messages.map((item) => item.id)).toEqual(["msg_temp_promote_1"]);

      const promotedLink = await messages1.promoteTemporarySessionMessages("ses_promote_1", work.id);
      expect(promotedLink.linkedCount).toBe(1);

      const anonAfter = await messages1.listMessages({ scope: "anonymous" });
      expect(anonAfter.messages).toEqual([]);
      db1.close();

      const db2 = new SqliteRelationalDatabase({ databasePath });
      try {
        const messages2 = new MailMessageService(db2, () => new Date("2026-09-03T01:10:00.000Z"), {
          accountRepository: db2,
        });

        const reopenedDraft = await messages2.getMessageDetail(savedDraft.messageId);
        expect(reopenedDraft).toMatchObject({
          id: savedDraft.messageId,
          accountId: work.id,
          subject: "Updated proposal",
          bodyText: "Draft text v2",
          bodyHtml: "<p>Draft html v2</p>",
          localFolder: "drafts",
          draftCcAddresses: ["bob@example.com"],
          draftBccAddresses: [],
        });

        const promotedList = await messages2.listMessages({
          scope: "promoted_account",
          accountId: work.id,
        });
        expect(promotedList.messages).toHaveLength(1);
        expect(promotedList.messages[0]).toMatchObject({
          id: "msg_temp_promote_1",
          accountId: work.id,
          sessionId: "ses_promote_1",
          sourceRefId: "ses_promote_1",
          isStarred: true,
          labels: ["Onboarding"],
        });

        await expect(messages2.deleteLocalDraft(savedDraft.messageId)).resolves.toMatchObject({
          messageId: savedDraft.messageId,
          changed: true,
          status: "deleted",
        });
        await expect(messages2.getMessageDetail(savedDraft.messageId)).rejects.toMatchObject({
          code: "MAIL_MESSAGE_NOT_FOUND",
        });
      } finally {
        db2.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
