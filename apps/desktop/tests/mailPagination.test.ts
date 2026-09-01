import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { paginateMailConversations } from "../src/mail/mailPagination.ts";

type Msg = { message_id: string };
type Conv = { key: string; messages: Msg[] };

function conversations(count: number, messagesEach = 1): Conv[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `c${index}`,
    messages: Array.from({ length: messagesEach }, (_, inner) => ({
      message_id: `c${index}-m${inner}`,
    })),
  }));
}

test("returns a single empty page when there are no conversations", () => {
  const result = paginateMailConversations<Conv>([], 0, 20);

  assert.equal(result.mailListTotalPages, 1);
  assert.equal(result.clampedMailListCurrentPage, 0);
  assert.equal(result.mailListPageStart, 0);
  assert.equal(result.mailListPageEnd, 0);
  assert.deepEqual(result.paginatedDisplayedMailConversations, []);
  assert.deepEqual(result.paginatedDisplayedMailMessages, []);
});

test("keeps a partial final page instead of padding it", () => {
  const result = paginateMailConversations<Conv>(conversations(25), 1, 20);

  assert.equal(result.mailListTotalPages, 2);
  assert.equal(result.mailListPageStart, 20);
  assert.equal(result.mailListPageEnd, 25);
  assert.equal(result.paginatedDisplayedMailConversations.length, 5);
});

test("does not create an extra empty page when the count is an exact multiple", () => {
  const result = paginateMailConversations<Conv>(conversations(40), 0, 20);

  assert.equal(result.mailListTotalPages, 2);
});

test("clamps a page index that is past the end after a filter narrows the list", () => {
  // The stored page survives a filter change, so it can point past the new end.
  const result = paginateMailConversations<Conv>(conversations(5), 7, 20);

  assert.equal(result.mailListTotalPages, 1);
  assert.equal(result.clampedMailListCurrentPage, 0);
  assert.equal(result.mailListPageStart, 0);
  assert.equal(result.paginatedDisplayedMailConversations.length, 5);
});

test("flattens every message of the paged conversations, not just the latest", () => {
  const result = paginateMailConversations<Conv>(conversations(3, 4), 0, 2);

  assert.equal(result.paginatedDisplayedMailConversations.length, 2);
  assert.deepEqual(
    result.paginatedDisplayedMailMessages.map((message) => message.message_id),
    ["c0-m0", "c0-m1", "c0-m2", "c0-m3", "c1-m0", "c1-m1", "c1-m2", "c1-m3"],
  );
});

// The mail derivation pipeline in App.tsx is split across three memos so that a
// checkbox click or a page turn does not re-run filter -> sort -> conversation
// grouping. That only holds while the pipeline memo's dependency array stays
// free of selection and pagination state, so assert it directly: a regression
// here is invisible in behavior but restores the full recompute.
test("mail derivation memo does not depend on selection or pagination state", () => {
  // Line endings are normalized because the markers below are \n-delimited, and a
  // fresh checkout on Windows yields CRLF. Without this the test fails on a clean
  // clone while passing in a working tree that happens to hold LF.
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const marker = "  const {\n    visibleMailMessages,";
  const start = app.indexOf(marker);
  assert.notEqual(start, -1, "could not locate the mail derivation memo");

  const depsStart = app.indexOf("  }, [", start);
  assert.notEqual(depsStart, -1, "could not locate the memo dependency array");
  const depsEnd = app.indexOf("]);", depsStart);
  const deps = app.slice(depsStart, depsEnd);

  for (const forbidden of [
    "selectedMailMessageIds",
    "selectedMailMessageId",
    "mailListCurrentPage",
  ]) {
    assert.ok(
      !deps.includes(forbidden),
      `${forbidden} must not be a dependency of the mail derivation memo`,
    );
  }
});
