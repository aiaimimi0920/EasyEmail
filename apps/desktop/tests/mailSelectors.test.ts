import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMailConversations,
  buildMailRailCounts,
  filterVisibleMailMessagesForMailbox,
  mailConversationKeyForMessage,
  normalizeMailToken,
  normalizeMailConversationSubject,
  sortMailListMessages,
  sortVisibleMailMessagesByTime,
  visibleMailMessageSortTimestamp,
} from "../src/mail/mailSelectors.ts";

type TestMessage = {
  message_id: string;
  observed_at: string;
  subject: string;
  from_address: string;
  received_address: string;
  snippet: string;
  body_text: string | null;
  labels: string[];
  newsletter_subscription_id: string | null;
  local_folder: string;
  sourceId: string;
  thread_key: string | null;
  is_read: boolean;
  is_starred: boolean;
  is_archived: boolean;
};

function message(overrides: Partial<TestMessage> = {}): TestMessage {
  return {
    message_id: "msg-default",
    observed_at: "2026-07-24T10:00:00Z",
    subject: "Project update",
    from_address: "Alice <alice@example.com>",
    received_address: "me@example.com",
    snippet: "Short preview",
    body_text: null,
    labels: [],
    newsletter_subscription_id: null,
    local_folder: "inbox",
    sourceId: "account:primary",
    thread_key: null,
    is_read: true,
    is_starred: false,
    is_archived: false,
    ...overrides,
  };
}

test("normalizes mailbox and taxonomy tokens consistently", () => {
  assert.equal(normalizeMailToken("  NewsLetters "), "newsletters");
  assert.equal(normalizeMailToken("\tArchive\n"), "archive");
});

test("parses RFC 2822 timestamps with timezone comments and rejects invalid dates", () => {
  assert.equal(
    visibleMailMessageSortTimestamp("Tue, 14 Apr 2026 11:14:35 +0000 (UTC)"),
    Date.parse("Tue, 14 Apr 2026 11:14:35 +0000"),
  );
  assert.equal(visibleMailMessageSortTimestamp("not-a-date"), 0);
  assert.equal(visibleMailMessageSortTimestamp("   "), 0);
});

test("sorts visible messages newest first with deterministic message-id tie breaking", () => {
  const result = sortVisibleMailMessagesByTime([
    message({ message_id: "msg-a", observed_at: "2026-07-24T09:00:00Z" }),
    message({ message_id: "msg-b", observed_at: "2026-07-24T11:00:00Z" }),
    message({ message_id: "msg-c", observed_at: "2026-07-24T11:00:00Z" }),
  ]);

  assert.deepEqual(
    result.map((item) => item.message_id),
    ["msg-c", "msg-b", "msg-a"],
  );
});

test("sorts the mail list by time or estimated content size", () => {
  const smallOld = message({
    message_id: "small-old",
    observed_at: "2026-07-23T08:00:00Z",
    subject: "A",
    snippet: "B",
  });
  const largeNew = message({
    message_id: "large-new",
    observed_at: "2026-07-24T08:00:00Z",
    subject: "A much longer subject",
    snippet: "A much longer preview body used for deterministic size ordering",
  });

  assert.deepEqual(
    sortMailListMessages([smallOld, largeNew], "newest").map((item) => item.message_id),
    ["large-new", "small-old"],
  );
  assert.deepEqual(
    sortMailListMessages([smallOld, largeNew], "oldest").map((item) => item.message_id),
    ["small-old", "large-new"],
  );
  assert.deepEqual(
    sortMailListMessages([smallOld, largeNew], "largest").map((item) => item.message_id),
    ["large-new", "small-old"],
  );
  assert.deepEqual(
    sortMailListMessages([smallOld, largeNew], "smallest").map((item) => item.message_id),
    ["small-old", "large-new"],
  );
});

test("custom folder view and rail count exclude every built-in mailbox", () => {
  const messages = [
    message({ message_id: "draft", local_folder: " Drafts ", is_read: false }),
    message({ message_id: "sent", local_folder: "SENT", is_read: false }),
    message({ message_id: "archive", local_folder: "Archive", is_read: false }),
    message({ message_id: "custom", local_folder: "Receipts", is_read: false }),
  ];

  assert.deepEqual(
    filterVisibleMailMessagesForMailbox(messages, "folders").map((item) => item.message_id),
    ["custom"],
  );
  const counts = buildMailRailCounts(messages);
  assert.equal(counts.drafts, 1);
  assert.equal(counts.sent, 1);
  assert.equal(counts.folders, 1);
  assert.deepEqual(
    filterVisibleMailMessagesForMailbox(messages, "drafts").map((item) => item.message_id),
    ["draft"],
  );
});

test("newsletter view trusts backend classification instead of broad subject keywords", () => {
  const keywordOnly = message({
    message_id: "keyword-only",
    subject: "Weekly project digest",
    is_read: false,
  });
  const classifiedById = message({
    message_id: "classified-id",
    newsletter_subscription_id: "list.example.test",
    is_read: false,
  });
  const classifiedByLabel = message({
    message_id: "classified-label",
    labels: ["Newsletters"],
    is_read: false,
  });
  const messages = [keywordOnly, classifiedById, classifiedByLabel];

  assert.deepEqual(
    filterVisibleMailMessagesForMailbox(messages, "newsletters").map((item) => item.message_id),
    ["classified-id", "classified-label"],
  );
  assert.equal(buildMailRailCounts(messages).newsletters, 2);
});

test("normalizes repeated reply and forward prefixes", () => {
  assert.equal(normalizeMailConversationSubject("Re: FW: 回复：[Fwd] Project Update"), "project update");
  assert.equal(normalizeMailConversationSubject("   "), "(no subject)");
});

test("prefers persisted thread keys and keeps sources isolated", () => {
  const primary = message({
    message_id: "primary",
    sourceId: "account:primary",
    thread_key: " RFC-Thread-1 ",
  });
  const sameThread = message({
    message_id: "same-thread",
    sourceId: "account:primary",
    thread_key: "rfc-thread-1",
    subject: "Completely different subject",
  });
  const otherSource = message({
    message_id: "other-source",
    sourceId: "account:secondary",
    thread_key: "rfc-thread-1",
  });

  assert.equal(mailConversationKeyForMessage(primary), mailConversationKeyForMessage(sameThread));
  assert.notEqual(mailConversationKeyForMessage(primary), mailConversationKeyForMessage(otherSource));
});

test("fallback grouping joins incoming and sent replies with the same counterparty", () => {
  const incoming = message({
    message_id: "incoming",
    subject: "Project update",
    from_address: "Alice <alice@example.com>",
    received_address: "me@example.com",
  });
  const sent = message({
    message_id: "sent",
    subject: "Re: Project update",
    from_address: "me@example.com",
    received_address: "Alice <alice@example.com>",
    local_folder: "sent",
  });

  assert.equal(mailConversationKeyForMessage(incoming), mailConversationKeyForMessage(sent));
});

test("drafts remain isolated even when their subjects match", () => {
  const first = message({ message_id: "draft-1", local_folder: "drafts" });
  const second = message({ message_id: "draft-2", local_folder: "drafts" });

  assert.notEqual(mailConversationKeyForMessage(first), mailConversationKeyForMessage(second));
});

test("builds chronological conversation stacks and aggregate state", () => {
  const oldest = message({
    message_id: "oldest",
    observed_at: "2026-07-23T08:00:00Z",
    is_read: false,
  });
  const newest = message({
    message_id: "newest",
    observed_at: "2026-07-24T08:00:00Z",
    subject: "Re: Project update",
    is_starred: true,
  });
  const verificationCode = { code: "123456" };

  const conversations = buildMailConversations(
    [newest, oldest],
    new Map([["oldest", verificationCode]]),
  );

  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].latestMessage.message_id, "newest");
  assert.deepEqual(
    conversations[0].messages.map((item) => item.message_id),
    ["oldest", "newest"],
  );
  assert.equal(conversations[0].unreadCount, 1);
  assert.equal(conversations[0].starred, true);
  assert.equal(conversations[0].verificationCode, verificationCode);
});

test("orders aggregated conversations by total estimated size when requested", () => {
  const largeOld = message({
    message_id: "large-old",
    observed_at: "2026-07-23T08:00:00Z",
    from_address: "large@example.com",
    subject: "A very long project update subject",
    snippet: "A very long project update preview that should rank first by size",
    body_text: "Additional body content for the size estimate",
  });
  const smallNew = message({
    message_id: "small-new",
    observed_at: "2026-07-24T08:00:00Z",
    from_address: "small@example.com",
    subject: "Short",
    snippet: "Tiny",
  });

  const conversations = buildMailConversations(
    [largeOld, smallNew],
    new Map(),
    "largest",
  );

  assert.deepEqual(
    conversations.map((conversation) => conversation.latestMessage.message_id),
    ["large-old", "small-new"],
  );
});

test("orders aggregated conversations oldest first when requested", () => {
  const older = message({
    message_id: "older",
    observed_at: "2026-07-23T08:00:00Z",
    from_address: "older@example.com",
  });
  const newer = message({
    message_id: "newer",
    observed_at: "2026-07-24T08:00:00Z",
    from_address: "newer@example.com",
  });

  const conversations = buildMailConversations([newer, older], new Map(), "oldest");

  assert.deepEqual(
    conversations.map((conversation) => conversation.latestMessage.message_id),
    ["older", "newer"],
  );
});
