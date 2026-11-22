import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailHttpError } from "../src/api/easyEmailHttpClient.ts";
import {
  createMailMessageClient,
  type MailMessageHttpTransport,
} from "../src/api/mailMessageClient.ts";
import type { EasyEmailMailMessageSummary } from "../src/api/easyEmailMessageTypes.ts";

function summaryFixture(
  overrides: Partial<EasyEmailMailMessageSummary> = {},
): EasyEmailMailMessageSummary {
  return {
    id: "msg_v1_1",
    accountId: "acct_v1_work",
    sourceRefId: "draft:acct_v1_work",
    sourceKind: "local_draft",
    receivedAddress: "alice@example.com",
    providerLabel: "Work IMAP",
    subject: "Draft subject",
    fromAddress: "work@example.com",
    snippet: "Preview snippet",
    hasAttachments: false,
    classification: "outgoing",
    lifecycleState: "draft",
    observedAt: "2026-09-03T04:00:00.000Z",
    isRead: true,
    isStarred: false,
    isArchived: false,
    isImportant: false,
    localFolder: "drafts",
    labels: ["FollowUp"],
    version: 2,
    ...overrides,
  };
}

function createTransport(): MailMessageHttpTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async listMailMessages(query) {
      calls.push(`list:${query?.scope ?? "all"}:${query?.cursor ?? "start"}`);
      if (!query?.cursor) {
        return {
          messages: [summaryFixture()],
          nextCursor: "cursor-2",
        };
      }
      return {
        messages: [summaryFixture({ id: "msg_v1_2", subject: "Second page" })],
      };
    },
    async getMailMessageDetail(messageId) {
      calls.push(`detail:${messageId}`);
      return {
        message: {
          ...summaryFixture({ id: messageId }),
          bodyText: "Plain text body",
          bodyHtml: "<p>Sanitized HTML</p>",
          rawHtmlAvailable: true,
          bodyCacheState: "cached",
          draftCcAddresses: ["cc@example.com"],
          draftBccAddresses: ["bcc@example.com"],
        },
      };
    },
    async saveLocalDraft(request) {
      calls.push(`saveDraft:${request.accountId}:${request.draftId ?? "new"}`);
      return {
        draft: {
          messageId: request.draftId ?? "msg_v1_draft_created",
          accountId: request.accountId,
          savedAt: "2026-09-03T04:05:00.000Z",
          version: 1,
        },
      };
    },
    async deleteLocalDraft(messageId) {
      calls.push(`deleteDraft:${messageId}`);
      return {
        action: { messageId, changed: true, status: "deleted", remoteApplied: false },
      };
    },
    async deleteMailMessageLocal(messageId) {
      calls.push(`deleteLocal:${messageId}`);
      return {
        action: { messageId, changed: true, status: "deleted_to_trash", remoteApplied: false },
      };
    },
    async deleteMailMessageForever(messageId) {
      calls.push(`deleteForever:${messageId}`);
      return {
        action: { messageId, changed: true, status: "deleted_forever", remoteApplied: false },
      };
    },
    async emptyMailTrash(request) {
      calls.push(`emptyTrash:${(request?.messageIds ?? []).join(",")}`);
      return {
        result: {
          requestedCount: request?.messageIds?.length ?? 0,
          changedCount: request?.messageIds?.length ?? 0,
          remoteAppliedCount: 0,
        },
      };
    },
    async setMailMessageLocalFlag(messageId, request) {
      calls.push(`flag:${messageId}:${request.flagName}:${String(request.enabled)}`);
      return {
        action: { messageId, changed: true, status: request.flagName, remoteApplied: false },
      };
    },
    async setMailMessageLocalFolder(messageId, request) {
      calls.push(`folder:${messageId}:${request.folderName}`);
      return {
        action: {
          messageId,
          changed: true,
          status: `folder:${request.folderName}`,
          remoteApplied: false,
        },
      };
    },
    async setMailMessageLocalLabel(messageId, request) {
      calls.push(`label:${messageId}:${request.labelName}:${String(request.enabled)}`);
      return {
        action: {
          messageId,
          changed: true,
          status: `label:${request.labelName}`,
          remoteApplied: false,
        },
      };
    },
    async listMailVerifications(query) {
      calls.push(`verifications:${query?.sessionId ?? "all"}:${String(query?.limit ?? 0)}`);
      return {
        verifications: [
          {
            id: "vcode_v1_1",
            messageId: "msg_v1_otp",
            sessionId: "ses_1",
            sourceRefId: "ses_1",
            accountScope: "normal",
            receivedAddress: "work@example.com",
            code: "123456",
            codeSource: "subject",
            candidates: ["123456"],
            issuerHint: "GitHub",
            targetServiceHint: "github",
            confidence: 0.96,
            expiresAt: "2026-09-03T04:15:00.000Z",
            isFresh: true,
            extractedAt: "2026-09-03T04:00:00.000Z",
            subject: "Code 123456",
            fromAddress: "noreply@github.com",
            observedAt: "2026-09-03T04:00:00.000Z",
          },
        ],
      };
    },
    async reclassifyMailMessageVerification(messageId) {
      calls.push(`reclassify:${messageId}`);
      return {};
    },
    async pollMailboxVerification(sessionId) {
      calls.push(`poll:${sessionId}`);
      return {
        refresh: {
          fetchedCount: 1,
          insertedCount: 1,
          skippedCount: 0,
          failedCount: 0,
          refreshedSessionIds: [sessionId],
          skippedSessionIds: [],
          failures: [],
        },
        detectedCode: {
          id: "vcode_v1_polled",
          messageId: "msg_v1_polled",
          sessionId,
          sourceRefId: sessionId,
          accountScope: "anonymous",
          receivedAddress: "temp@example.test",
          code: "889900",
          codeSource: "text",
          candidates: ["889900"],
          confidence: 0.92,
          isFresh: true,
          extractedAt: "2026-09-03T04:06:00.000Z",
          subject: "Your code",
          fromAddress: "auth@example.test",
          observedAt: "2026-09-03T04:06:00.000Z",
        },
      };
    },
  };
}

test("paginates canonical messages and maps details, drafts, local actions, and verification DTOs", async () => {
  const transport = createTransport();
  const client = createMailMessageClient(transport);

  const normalMessages = await client.listNormalAccountMessages("acct_v1_work");
  assert.deepEqual(
    normalMessages.map((item) => item.message_id),
    ["msg_v1_1", "msg_v1_2"],
  );
  assert.deepEqual(normalMessages[0]?.labels, ["FollowUp"]);

  const detail = await client.getMessageDetail("msg_v1_1");
  assert.equal(detail.account_id, "acct_v1_work");
  assert.equal(detail.body_html, "<p>Sanitized HTML</p>");
  assert.deepEqual(detail.draft_cc_addresses, ["cc@example.com"]);

  const savedDraft = await client.saveLocalDraft({
    draft_id: null,
    account_id: "acct_v1_work",
    target_address: "alice@example.com",
    cc_addresses: ["cc@example.com"],
    bcc_addresses: [],
    subject: "Hello",
    body_text: "Body",
    body_html: "<p>Body</p>",
  });
  assert.deepEqual(savedDraft, {
    message_id: "msg_v1_draft_created",
    saved_at: "2026-09-03T04:05:00.000Z",
  });

  await client.setMessageLocalFlag("msg_v1_1", "starred", true);
  await client.setMessageLocalFolder("msg_v1_1", "archive");
  await client.setMessageLocalLabel("msg_v1_1", "Urgent", true);
  await client.deleteMessageLocal("msg_v1_1");
  await client.deleteMessageForever("msg_v1_1");
  assert.deepEqual(await client.emptyTrash(["msg_v1_1", "msg_v1_2"]), {
    requested_count: 2,
    changed_count: 2,
    remote_applied_count: 0,
  });

  const codes = await client.listRecentVerifications("ses_1", 50);
  assert.equal(codes[0]?.account_scope, "normal_account");
  assert.equal(codes[0]?.code, "123456");
  assert.equal(await client.reclassifyMessageVerification("msg_v1_1"), null);

  const polled = await client.pollTempMailboxVerification("ses_1");
  assert.equal(polled.refresh.inserted_count, 1);
  assert.equal(polled.detected_code?.code, "889900");
});

test("treats 404 on deleteLocalDraft as an idempotent not_found action and rejects repeated pagination cursors", async () => {
  const transport = createTransport();
  transport.deleteLocalDraft = async () => {
    throw new EasyEmailHttpError(404, "Draft not found", { code: "MAIL_MESSAGE_NOT_FOUND" });
  };
  const client = createMailMessageClient(transport);

  assert.deepEqual(await client.deleteLocalDraft("stale_draft"), {
    message_id: "stale_draft",
    changed: false,
    status: "not_found",
    remote_applied: false,
  });

  transport.listMailMessages = async () => ({
    messages: [],
    nextCursor: "stuck-cursor",
  });
  await assert.rejects(client.listAnonymousMessages(), /repeated cursor/);
});
