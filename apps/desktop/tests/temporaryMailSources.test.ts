import assert from "node:assert/strict";
import test from "node:test";

import type { AnonymousMessageDto, TempMailboxDto } from "../src/app/appTypes.ts";
import {
  attachTemporaryMailboxSources,
  buildTemporaryMailboxSources,
  temporaryMailboxIdFromSourceId,
  temporaryMailboxSourceId,
} from "../src/app/temporaryMailSources.ts";

function mailbox(id: string, emailAddress: string): TempMailboxDto {
  return {
    id,
    email_address: emailAddress,
    provider_id: `provider-${id}`,
    provider_label: "Test provider",
    visibility_state: "anonymous",
    lifecycle_state: "active",
    easyemail_mailbox_id: `easyemail-${id}`,
    lease_expires_at: null,
    created_at: "2026-09-05T00:00:00Z",
    updated_at: "2026-09-05T00:00:00Z",
  };
}

function message(id: string, mailboxId: string, address: string): AnonymousMessageDto {
  return {
    message_id: id,
    thread_key: null,
    temp_mailbox_id: mailboxId,
    received_address: address,
    provider_label: "Test provider",
    subject: "Test message",
    from_address: "sender@example.com",
    snippet: "Preview",
    observed_at: "2026-09-05T00:00:00Z",
    lifecycle_state: "active",
    is_read: false,
    is_starred: false,
    is_archived: false,
    is_important: false,
    local_folder: "inbox",
    labels: [],
    newsletter_subscription_id: null,
  };
}

test("builds one visible mail source per temporary mailbox address", () => {
  const first = mailbox("mailbox-first", "first@example.com");
  const second = mailbox("mailbox-second", "second@example.com");
  const sources = buildTemporaryMailboxSources(
    [first, second],
    [message("first-message", first.id, first.email_address)],
  );

  assert.deepEqual(
    sources.map(({ id, label, meta }) => ({ id, label, meta })),
    [
      {
        id: "temp:mailbox-first",
        label: "first@example.com",
        meta: "1 封邮件 / Test provider",
      },
      {
        id: "temp:mailbox-second",
        label: "second@example.com",
        meta: "0 封邮件 / Test provider",
      },
    ],
  );
});

test("attaches stable per-mailbox source identity to temporary messages", () => {
  const known = mailbox("mailbox-known", "known@example.com");
  const visible = attachTemporaryMailboxSources(
    [
      message("known-message", known.id, known.email_address),
      message("restored-message", "mailbox-restored", "restored@example.com"),
    ],
    [known],
  );

  assert.deepEqual(
    visible.map(({ sourceId, sourceLabel }) => ({ sourceId, sourceLabel })),
    [
      { sourceId: "temp:mailbox-known", sourceLabel: "known@example.com" },
      { sourceId: "temp:mailbox-restored", sourceLabel: "restored@example.com" },
    ],
  );
  assert.equal(temporaryMailboxSourceId(known.id), "temp:mailbox-known");
  assert.equal(temporaryMailboxIdFromSourceId("temp:mailbox-known"), known.id);
  assert.equal(temporaryMailboxIdFromSourceId("temp"), null);
  assert.equal(temporaryMailboxIdFromSourceId("temp:"), null);
  assert.equal(temporaryMailboxIdFromSourceId("account:mailbox-known"), null);
});
