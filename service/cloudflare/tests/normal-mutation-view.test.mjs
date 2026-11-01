import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

let checked;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mutation-view-")), outfile = path.join(directory, "view.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../web/normal-remote-mutation-model.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  checked = (await import(pathToFileURL(outfile))).checkedRemoteMutation;
});
const accountId = crypto.randomUUID(), messageId = crypto.randomUUID(), serverFolderId = "a".repeat(64);
const row = { id: crypto.randomUUID(), accountId, messageId, serverFolderId, accountRevision: 1, epochId: crypto.randomUUID(), uid: 2, uidValidity: "42",
  requestKey: crypto.randomUUID(), action: "move", state: "confirmed", phase: "move", method: "move", sourceRemoved: true,
  destinationFolderId: "b".repeat(64), destinationEpochId: crypto.randomUUID(), destination: { uidValidity: "42", uid: 501 },
  error: null, retrySafe: false, cacheRetained: true, createdAt: 100, dispatchedAt: 101, phaseAt: 101, finishedAt: 102 };
const attempt = { accountId, messageId, serverFolderId, uid: 2, key: row.requestKey,
  body: { expectedRevision: 1, epochId: row.epochId, action: "move", destinationFolderId: row.destinationFolderId,
    destinationEpochId: row.destinationEpochId, confirmRemoteChange: true } };
for (const [name, patch] of [
  ["wrong account", { accountId: crypto.randomUUID() }], ["wrong message", { messageId: crypto.randomUUID() }],
  ["wrong folder", { serverFolderId: "c".repeat(64) }], ["missing source folder", { serverFolderId: undefined }],
  ["wrong key", { requestKey: crypto.randomUUID() }], ["wrong revision", { accountRevision: 2 }],
  ["wrong epoch", { epochId: crypto.randomUUID() }], ["wrong uid", { uid: 3 }],
  ["wrong destination", { destinationFolderId: "c".repeat(64) }], ["wrong destination epoch", { destinationEpochId: crypto.randomUUID() }],
  ["invalid uidvalidity", { uidValidity: "0" }], ["oversized uid", { uid: 4294967296 }],
  ["retry claim", { retrySafe: true }], ["cache moved claim", { cacheRetained: false }],
  ["unconfirmed removal", { sourceRemoved: false }], ["missing mapping", { destination: null }],
  ["invalid mapping", { destination: { uidValidity: "42", uid: 0 } }], ["contradictory method", { method: "delete" }],
  ["contradictory phase", { phase: "copy" }], ["confirmed error", { error: "remote_mutation_outcome_unknown" }],
  ["missing finish", { finishedAt: null }], ["invalid finish", { finishedAt: -1 }],
  ["failed but dispatched", { state: "failed", sourceRemoved: false, error: "remote_mutation_target_changed" }],
  ["pending but completed", { state: "pending", sourceRemoved: false }],
  ["unknown but removed", { state: "unknown", error: "remote_mutation_outcome_unknown" }],
]) test(`mutation receipt refuses ${name}`, () => {
  assert.throws(() => checked({ ...row, ...patch }, accountId, messageId, attempt), error => error.message === "remote_mutation_response_invalid");
});
test("historical, pending, unknown, failed and canonical INBOX facts stay readable without inventing confirmation", () => {
  assert.deepEqual(checked(row, accountId, messageId, attempt), row);
  assert.deepEqual(checked({ ...row, accountRevision: 2 }, accountId, messageId, undefined, serverFolderId).accountRevision, 2);
  const pending = { ...row, state: "pending", sourceRemoved: false, finishedAt: null };
  assert.deepEqual(checked(pending, accountId, messageId, attempt), pending);
  const unknown = { ...pending, state: "unknown", error: "remote_mutation_outcome_unknown" };
  assert.deepEqual(checked(unknown, accountId, messageId, attempt), unknown);
  const failed = { ...unknown, state: "failed", phase: null, method: null, destination: null, dispatchedAt: null, phaseAt: null, finishedAt: 102 };
  assert.deepEqual(checked(failed, accountId, messageId, attempt), failed);
  const canonical = { ...row }; delete canonical.serverFolderId;
  assert.deepEqual(checked(canonical, accountId, messageId), canonical);
  assert.throws(() => checked(row, accountId, messageId), /remote_mutation_response_invalid/);
});
test("permanent deletion cannot masquerade as movement or carry a destination", () => {
  const deletion = { ...row, action: "delete", method: "delete", phase: "expunge", destination: null, destinationFolderId: null, destinationEpochId: null };
  const held = { ...attempt, body: { expectedRevision: 1, epochId: row.epochId, action: "delete", confirmPermanentDelete: true } };
  assert.deepEqual(checked(deletion, accountId, messageId, held), deletion);
  assert.throws(() => checked(deletion, accountId, messageId, attempt), /remote_mutation_response_invalid/);
  assert.throws(() => checked({ ...deletion, destination: row.destination }, accountId, messageId, held), /remote_mutation_response_invalid/);
});
