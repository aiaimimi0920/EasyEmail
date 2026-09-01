import assert from "node:assert/strict";
import test from "node:test";

import {
  detectInlineVerificationCode,
  mailSearchMessageMatchesAdvancedFilters,
  visibleMailMessageSearchText,
  type MailSearchAdvancedFilters,
  type MailSearchMessage,
} from "../src/mail/mailSearch.ts";

const message: MailSearchMessage = {
  message_id: "message-1",
  temp_mailbox_id: "temp-1",
  sourceId: "account-1",
  sourceLabel: "工作邮箱",
  local_folder: "inbox",
  account_id: "account-1",
  subject: "Login verification code 123456",
  from_address: "Security <security@example.com>",
  received_address: "owner@example.com",
  snippet: "Use 1234 or the preferred one-time code 123456. Report.pdf attached.",
  body_text: "This full-text-only phrase is searchable.",
  labels: ["Important"],
  observed_at: "2026-03-04T12:30:00+08:00",
};

const filters: MailSearchAdvancedFilters = {
  query: "",
  fullText: true,
  startDate: "",
  endDate: "",
  sender: "",
  recipient: "",
  address: "all",
  hasAttachment: false,
};

test("search text includes message body only in full-text mode", () => {
  assert.match(visibleMailMessageSearchText(message), /full-text-only/);
  assert.doesNotMatch(visibleMailMessageSearchText(message, false), /full-text-only/);
  assert.match(visibleMailMessageSearchText(message, false), /工作邮箱/);
});

test("inline verification detection prefers six digits and preserves message identity", () => {
  const result = detectInlineVerificationCode(message);

  assert.equal(result?.code, "123456");
  assert.equal(result?.id, "inline:message-1");
  assert.equal(result?.account_scope, "normal_account");
  assert.equal(result?.confidence, 0.78);
});

test("inline verification detection rejects non-keyword short numbers", () => {
  assert.equal(
    detectInlineVerificationCode({
      ...message,
      subject: "Order 1234",
      snippet: "Your order is ready",
      body_text: "",
    }),
    null,
  );
});

test("advanced search applies text date address and attachment filters", () => {
  assert.equal(
    mailSearchMessageMatchesAdvancedFilters(message, {
      ...filters,
      query: "full-text-only",
      startDate: "2026-03-04",
      endDate: "2026-03-04",
      sender: "security@example.com",
      recipient: "owner@example.com",
      address: "account-1",
      hasAttachment: true,
    }),
    true,
  );
  assert.equal(
    mailSearchMessageMatchesAdvancedFilters(message, { ...filters, startDate: "2026-03-05" }),
    false,
  );
  assert.equal(
    mailSearchMessageMatchesAdvancedFilters(message, {
      ...filters,
      query: "full-text-only",
      fullText: false,
    }),
    false,
  );
});
