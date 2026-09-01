import assert from "node:assert/strict";
import test from "node:test";

import {
  composeDateInputValue,
  defaultComposeCustomScheduleDate,
  defaultComposeExpirationDate,
  formatComposeDraftSavedAt,
  formatComposeLocalDateTimeInput,
  formatComposeScheduleDate,
  positivePort,
} from "../src/compose/composeDateUtils.ts";

test("formats compose dates for native date and datetime-local controls", () => {
  const date = new Date(2026, 2, 4, 5, 6, 7, 8);

  assert.equal(composeDateInputValue(date), "2026-03-04");
  assert.equal(formatComposeLocalDateTimeInput(date), "2026-03-04T05:06");
  assert.match(formatComposeScheduleDate(date), /3月4日/);
});

test("defaults custom scheduling to the next whole minute one hour ahead", () => {
  const now = new Date(2026, 2, 4, 5, 6, 37, 123);
  const scheduled = defaultComposeCustomScheduleDate(now);

  assert.equal(formatComposeLocalDateTimeInput(scheduled), "2026-03-04T06:06");
  assert.equal(scheduled.getSeconds(), 0);
  assert.equal(scheduled.getMilliseconds(), 0);
});

test("defaults expiration to seven calendar days and reports unsaved drafts", () => {
  assert.equal(defaultComposeExpirationDate(new Date(2026, 2, 28, 23, 59)), "2026-04-04");
  assert.equal(formatComposeDraftSavedAt(null), "未保存");
  assert.equal(formatComposeDraftSavedAt("not-a-date"), "未保存");
  assert.match(formatComposeDraftSavedAt("2026-03-04T05:06:00+08:00"), /^保存于 /);
});

test("accepts positive ports and falls back for invalid values", () => {
  assert.equal(positivePort("465", 993), 465);
  assert.equal(positivePort("0", 993), 993);
  assert.equal(positivePort("65536", 993), 993);
  assert.equal(positivePort("465smtp", 993), 993);
  assert.equal(positivePort("not-a-port", 465), 465);
});
