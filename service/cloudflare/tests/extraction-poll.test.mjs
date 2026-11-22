import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { test } from "node:test";

const source = stripTypeScriptTypes(await readFile(new URL("../web/extraction-poll.ts", import.meta.url), "utf8"));
const { waitForExtractions } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
const waiting = (nextPage = null) => ({ state: "waiting", items: [], retryAfterSeconds: 5, searched: 0,
  searchLimited: false, sync: { nextPage, complete: nextPage === null, missing: 0 } });
function clock() {
  let time = 0;
  const sleeps = [];
  return { now: () => time, advance: (ms) => { time += ms; }, sleeps,
    sleep: async (ms, signal) => { signal.throwIfAborted(); sleeps.push(ms); time += ms; } };
}

test("polling serially follows continuation then restarts page one; stops on the first match", async () => {
  const c = clock(), pages = [], progress = [], controller = new AbortController();
  const result = await waitForExtractions(async (page, signal) => {
    assert.equal(signal.aborted, false); pages.push(page);
    return pages.length === 3 ? { ...waiting(), state: "matched", items: [{ messageId: "synthetic" }] } : waiting(pages.length === 1 ? 2 : null);
  }, controller.signal, (value, attempt) => progress.push({ value, attempt }), c);
  assert.equal(result.state, "matched"); assert.equal(result.attempts, 3);
  assert.deepEqual(pages, [1, 2, 1]); assert.deepEqual(c.sleeps, [5000, 5000]);
  assert.deepEqual(progress.map((item) => item.attempt), [1, 2, 3]);
});

test("waiting has a hard twelve-check budget and cannot hot-loop", async () => {
  const c = clock(); let checks = 0;
  const result = await waitForExtractions(async () => { checks++; return { ...waiting(), retryAfterSeconds: 0 }; },
    new AbortController().signal, () => {}, c);
  assert.equal(result.state, "exhausted"); assert.equal(result.attempts, 12); assert.equal(checks, 12);
  assert.equal(c.sleeps.length, 11); assert.ok(c.sleeps.every((ms) => ms >= 5000));
});

test("elapsed time is bounded and a late response cannot become a fresh success", async () => {
  const c = clock(), progress = [];
  const result = await waitForExtractions(async () => {
    c.advance(60000); return { ...waiting(), state: "matched", items: [{ messageId: "late" }] };
  }, new AbortController().signal, (value) => progress.push(value), c);
  assert.equal(result.state, "exhausted"); assert.equal(result.attempts, 1); assert.deepEqual(progress, []);
});

test("the production deadline aborts an in-flight check when its timer expires", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let checks = 0;
  const pending = waitForExtractions((_page, signal) => {
    checks++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }, new AbortController().signal, () => assert.fail("deadline published a result"));
  t.mock.timers.tick(60000);
  const result = await pending;
  assert.equal(result.state, "exhausted"); assert.equal(result.attempts, 1); assert.equal(checks, 1);
});

test("cancelled, failed or timed-out checks never schedule a retry or publish a late match", async () => {
  const controller = new AbortController(), c = clock(); let checks = 0;
  await assert.rejects(waitForExtractions(async () => {
    checks++; controller.abort(); return { ...waiting(), state: "matched", items: [{ messageId: "cancelled" }] };
  }, controller.signal, () => assert.fail("cancelled response published"), c), { name: "AbortError" });
  assert.equal(checks, 1); assert.equal(c.sleeps.length, 0);
  const failure = new Error("synthetic-provider-failure"); checks = 0;
  await assert.rejects(waitForExtractions(async () => { checks++; throw failure; },
    new AbortController().signal, () => {}, c), (error) => error === failure);
  assert.equal(checks, 1);
});
