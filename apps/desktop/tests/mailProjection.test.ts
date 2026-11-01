import assert from "node:assert/strict";
import test from "node:test";

import type { AccountDto } from "../src/api/mailAccountClient.ts";
import {
  deriveMailProjection,
  type MailProjectionInput,
} from "../src/app/mailProjection.ts";
import type { VisibleMailMessage } from "../src/app/appTypes.ts";
import type { VerificationCodeDto } from "../src/mail/mailSearch.ts";

function message(overrides: Partial<VisibleMailMessage> = {}): VisibleMailMessage {
  return {
    message_id: "message-default",
    thread_key: null,
    temp_mailbox_id: "temp-1",
    received_address: "me@example.com",
    provider_label: "Test",
    subject: "Project update",
    from_address: "sender@example.com",
    snippet: "Preview",
    observed_at: "2026-09-04T08:00:00Z",
    lifecycle_state: "active",
    is_read: false,
    is_starred: false,
    is_archived: false,
    is_important: false,
    local_folder: "inbox",
    labels: [],
    newsletter_subscription_id: null,
    sourceLabel: "All mail",
    sourceId: "all",
    body_text: null,
    ...overrides,
  };
}

function account(overrides: Partial<AccountDto> = {}): AccountDto {
  return {
    id: "work",
    scope: "normal",
    kind: "normal_long_lived",
    display_name: "Work Mail",
    primary_address: "Work@Example.com",
    provider_label: null,
    status: "active",
    auth_status: "ready",
    receive_status: "ready",
    send_status: "ready",
    listed_in_all_accounts: true,
    version: 1,
    credential_refs: [],
    ...overrides,
  };
}

function projectionInput(overrides: Partial<MailProjectionInput> = {}): MailProjectionInput {
  return {
    mailSourceId: "all",
    normalMessagesByAccount: {},
    promotedMessagesByAccount: {},
    mailboxView: "all-mail",
    selectedMailTaxonomyFilter: null,
    selectedNewsletterSubscription: null,
    mailSearchStartDate: "",
    mailSearchEndDate: "",
    mailSearchSender: "",
    mailSearchRecipient: "",
    mailSearchAddress: "all",
    mailSearchHasAttachment: false,
    onlyCodes: false,
    mailSearchQuery: "",
    mailSearchScope: "all-mail",
    recentCodes: [],
    mailSearchFullText: true,
    mailListReadFilter: "all",
    mailListHasAttachmentOnly: false,
    mailListSortMode: "newest",
    mailSearchFolderFilter: "",
    tempVisibleMessages: [],
    normalImapAccounts: [],
    promotedAccounts: [],
    allVisibleMailMessages: [],
    ...overrides,
  };
}

function verificationCode(overrides: Partial<VerificationCodeDto> = {}): VerificationCodeDto {
  return {
    id: "code-1",
    message_id: "code-message",
    temp_mailbox_id: "temp-1",
    source_id: "temp",
    account_scope: "anonymous",
    received_address: "me@example.com",
    code: "999999",
    issuer_hint: "Trusted issuer",
    target_service_hint: null,
    confidence: 0.99,
    expires_at: null,
    extracted_at: "2026-09-04T08:00:00Z",
    subject: "Security notice",
    from_address: "security@example.com",
    observed_at: "2026-09-04T08:00:00Z",
    ...overrides,
  };
}

test("projects account sources with stable labels, ordering, taxonomy, and search options", () => {
  const work = account();
  const result = deriveMailProjection(
    projectionInput({
      mailSourceId: "account:work",
      normalImapAccounts: [work],
      normalMessagesByAccount: {
        work: [
          message({
            message_id: "inbox-newer",
            observed_at: "2026-09-04T10:00:00Z",
          }),
          message({
            message_id: "receipt-older",
            observed_at: "2026-09-03T10:00:00Z",
            local_folder: " Receipts ",
          }),
        ],
      },
      mailboxView: "folders",
      selectedMailTaxonomyFilter: { kind: "folder", name: "receipts" },
      mailSearchFolderFilter: "spam",
    }),
  );

  assert.deepEqual(
    result.visibleMailMessages.map((item) => item.message_id),
    ["inbox-newer", "receipt-older"],
  );
  assert.deepEqual(
    result.visibleMailMessages.map(({ sourceId, sourceLabel, account_id }) => ({
      sourceId,
      sourceLabel,
      account_id,
    })),
    [
      { sourceId: "account:work", sourceLabel: "Work Mail", account_id: "work" },
      { sourceId: "account:work", sourceLabel: "Work Mail", account_id: "work" },
    ],
  );
  assert.deepEqual(result.displayedMailMessages.map((item) => item.message_id), ["receipt-older"]);
  assert.deepEqual(result.mailSearchAddressOptions, [
    { id: "all", label: "全部" },
    { id: "work@example.com", label: "Work@Example.com" },
  ]);
  assert.deepEqual(result.filteredMailSearchOtherScopes.map((scope) => scope.id), ["spam"]);
  assert.equal(result.mailSearchResultLabel, "搜索邮件");
});

test("keeps newsletter selection local until advanced search becomes active", () => {
  const selected = message({
    message_id: "selected-newsletter",
    account_id: "work",
    newsletter_subscription_id: "selected-list",
    labels: ["Newsletters"],
  });
  const other = message({
    message_id: "other-newsletter",
    account_id: "work",
    newsletter_subscription_id: "other-list",
    labels: ["Newsletters"],
  });
  const alert = message({
    message_id: "global-alert",
    from_address: "alerts@example.com",
    local_folder: "archive",
  });
  const base = projectionInput({
    mailboxView: "newsletters",
    selectedNewsletterSubscription: { accountId: "work", subscriptionId: "selected-list" },
    allVisibleMailMessages: [selected, other, alert],
  });

  assert.deepEqual(
    deriveMailProjection(base).displayedMailMessages.map((item) => item.message_id),
    ["selected-newsletter"],
  );

  const searched = deriveMailProjection({ ...base, mailSearchSender: "alerts@example.com" });
  assert.equal(searched.mailSearchHasAdvancedCriteria, true);
  assert.deepEqual(searched.displayedMailMessages.map((item) => item.message_id), ["global-alert"]);
  assert.equal(searched.mailSearchResultLabel, "1 条结果 · 所有邮件");
});

test("prefers persisted verification codes and derives inline fallbacks in code-only mode", () => {
  const persistedMessage = message({
    message_id: "code-message",
    subject: "Verification code 123456",
    observed_at: "2026-09-04T09:00:00Z",
    sourceId: "temp",
  });
  const inlineMessage = message({
    message_id: "inline-message",
    subject: "Sign in code 654321",
    observed_at: "2026-09-04T08:00:00Z",
    sourceId: "temp",
  });
  const result = deriveMailProjection(
    projectionInput({
      mailSourceId: "temp",
      tempVisibleMessages: [persistedMessage, inlineMessage],
      allVisibleMailMessages: [persistedMessage, inlineMessage],
      onlyCodes: true,
      recentCodes: [verificationCode()],
    }),
  );

  assert.deepEqual(
    result.codeBackedMailMessages.map((item) => [item.message_id, item.verificationCode.code]),
    [
      ["code-message", "999999"],
      ["inline-message", "654321"],
    ],
  );
  assert.deepEqual(
    result.displayedMailConversations.map((conversation) => conversation.latestMessage.message_id),
    ["code-message", "inline-message"],
  );
  assert.equal(result.displayedMailMessageKey, "code-message|inline-message");
  assert.equal(result.mailSearchResultLabel, "2 / 2 条验证码结果 · 所有邮件");
});

test("isolates messages for a concrete temporary mailbox source", () => {
  const firstMailboxMessage = message({
    message_id: "temp-first",
    temp_mailbox_id: "mailbox-first",
    received_address: "first@example.com",
    sourceId: "temp:mailbox-first",
    sourceLabel: "first@example.com",
  });
  const secondMailboxMessage = message({
    message_id: "temp-second",
    temp_mailbox_id: "mailbox-second",
    received_address: "second@example.com",
    sourceId: "temp:mailbox-second",
    sourceLabel: "second@example.com",
  });
  const result = deriveMailProjection(
    projectionInput({
      mailSourceId: "temp:mailbox-first",
      tempVisibleMessages: [firstMailboxMessage, secondMailboxMessage],
      allVisibleMailMessages: [firstMailboxMessage, secondMailboxMessage],
    }),
  );

  assert.deepEqual(result.visibleMailMessages, [firstMailboxMessage]);
  assert.deepEqual(result.displayedMailMessages, [firstMailboxMessage]);
});

test("filters list rows while retaining the full matching conversation", () => {
  const matchingUnread = message({
    message_id: "matching-unread",
    thread_key: "thread-1",
    snippet: "Please review the attached file",
    observed_at: "2026-09-04T08:00:00Z",
  });
  const readSibling = message({
    message_id: "read-sibling",
    thread_key: "thread-1",
    is_read: true,
    observed_at: "2026-09-04T09:00:00Z",
  });
  const unreadWithoutAttachment = message({
    message_id: "unread-without-attachment",
    from_address: "other@example.com",
    observed_at: "2026-09-04T10:00:00Z",
  });
  const result = deriveMailProjection(
    projectionInput({
      allVisibleMailMessages: [
        matchingUnread,
        readSibling,
        unreadWithoutAttachment,
      ],
      mailListReadFilter: "unread",
      mailListHasAttachmentOnly: true,
    }),
  );

  assert.deepEqual(result.displayedMailMessages.map((item) => item.message_id), [
    "matching-unread",
  ]);
  assert.equal(result.displayedMailConversations.length, 1);
  assert.deepEqual(
    result.displayedMailConversations[0].messages.map((item) => item.message_id),
    ["matching-unread", "read-sibling"],
  );
  assert.equal(result.displayedMailMessageKey, "matching-unread|read-sibling");
});

test("returns no scheduled-scope mail and falls back to normalized account ids", () => {
  const withoutAddress = account({
    id: "NoAddress",
    display_name: "No Address",
    primary_address: null,
  });
  const promoted = account({
    id: "promoted",
    display_name: "Promoted",
    primary_address: "Promoted@Example.com",
  });
  const result = deriveMailProjection(
    projectionInput({
      mailSearchScope: "scheduled",
      allVisibleMailMessages: [message()],
      normalImapAccounts: [withoutAddress],
      promotedAccounts: [promoted],
    }),
  );

  assert.deepEqual(result.displayedMailMessages, []);
  assert.deepEqual(result.mailSearchAddressOptions, [
    { id: "all", label: "全部" },
    { id: "noaddress", label: "No Address" },
    { id: "promoted@example.com", label: "Promoted@Example.com" },
  ]);
});
