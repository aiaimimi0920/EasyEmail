import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let checked;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "flags-view-")), outfile = path.join(directory, "view.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../web/normal-remote-flags.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  checked = (await import(pathToFileURL(outfile))).checkedRemoteFlag;
});
const accountId = crypto.randomUUID(), messageId = crypto.randomUUID();
const row = { id: crypto.randomUUID(), accountId, messageId, accountRevision: 1, epochId: crypto.randomUUID(), uid: 7,
  flag: "\\Flagged", value: true, acknowledgedUnknownId: null, requestKey: crypto.randomUUID(), retrySafe: false,
  state: "confirmed", remoteFlags: ["\\Flagged"], error: null, createdAt: 1793415000, dispatchedAt: 1793415001, finishedAt: 1793415002 };
for (const [name, patch] of [
  ["failed but dispatched", { state: "failed", remoteFlags: null, error: "remote_flags_target_changed" }],
  ["failed without completion", { state: "failed", remoteFlags: null, dispatchedAt: null, finishedAt: null, error: "remote_flags_target_changed" }],
  ["pending but completed", { state: "pending", remoteFlags: null }],
  ["unknown but confirmed flags", { state: "unknown" }],
  ["confirmed with error", { error: "remote_flags_outcome_unknown" }],
  ["confirmed without intended flag", { remoteFlags: [] }],
]) test(`contradictory receipt is not accepted: ${name}`, () => {
  assert.throws(() => checked({ ...row, ...patch }, accountId, messageId), error => error.message === "remote_flags_response_invalid");
});
test("historical confirmed and truthful non-dispatched failed receipts remain readable", () => {
  assert.deepEqual(checked(row, accountId, messageId), row);
  const failed = { ...row, state: "failed", remoteFlags: null, dispatchedAt: null, error: "remote_flags_target_changed" };
  assert.deepEqual(checked(failed, accountId, messageId), failed);
});
test("directory receipts require the exact original folder both for latest reads and held requests", () => {
  const serverFolderId = "a".repeat(64), value = { ...row, serverFolderId };
  const attempt = { accountId, messageId, serverFolderId, key: row.requestKey,
    body: { expectedRevision: 1, epochId: row.epochId, flag: row.flag, value: row.value, acknowledgedUnknownId: null } };
  assert.deepEqual(checked(value, accountId, messageId, attempt), value);
  assert.deepEqual(checked(value, accountId, messageId, undefined, serverFolderId), value);
  for (const invalid of [row, { ...value, serverFolderId: "b".repeat(64) }, { ...value, serverFolderId: "a" }, { ...value, serverFolderId: null }]) {
    assert.throws(() => checked(invalid, accountId, messageId, attempt), error => error.message === "remote_flags_response_invalid");
    assert.throws(() => checked(invalid, accountId, messageId, undefined, serverFolderId), error => error.message === "remote_flags_response_invalid");
  }
  assert.throws(() => checked(value, accountId, messageId), error => error.message === "remote_flags_response_invalid");
});
