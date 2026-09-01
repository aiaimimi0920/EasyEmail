import assert from "node:assert/strict";
import test from "node:test";

import { formatMailListTime } from "../src/mail/mailDateUtils.ts";

test("formats messages from today yesterday and the day before", () => {
  const now = new Date(2026, 6, 20, 12, 0);

  assert.equal(formatMailListTime(new Date(2026, 6, 20, 8, 5).toISOString(), now), "08:05");
  assert.equal(
    formatMailListTime(new Date(2026, 6, 19, 9, 6).toISOString(), now),
    "昨天 09:06",
  );
  assert.equal(
    formatMailListTime(new Date(2026, 6, 18, 10, 7).toISOString(), now),
    "前天 10:07",
  );
});

test("formats older messages as a stable local calendar date", () => {
  const now = new Date(2026, 6, 20, 12, 0);

  assert.equal(
    formatMailListTime(new Date(2026, 0, 2, 8, 5).toISOString(), now),
    "2026/01/02",
  );
});

test("preserves the original value when the message date is invalid", () => {
  assert.equal(formatMailListTime("not-a-date", new Date(2026, 6, 20, 12, 0)), "not-a-date");
});
