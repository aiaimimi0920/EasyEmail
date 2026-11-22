import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let checked, rejected, ApiError;
before(async () => {
  await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "sync-view-")), outfile = path.join(directory, "view.mjs");
  await build({ stdin: { contents: 'export * from "./normal-sync-receipt"; export { ApiError } from "./api";',
    resolveDir: fileURLToPath(new URL("../web", import.meta.url)) }, outfile, bundle: true, format: "esm", platform: "neutral" });
  const module = await import(pathToFileURL(outfile)); checked = module.checkedNormalSync; rejected = module.normalSyncRejectedBeforeReservation; ApiError = module.ApiError;
});
test("sync receipt requires exact account, folder, revision, key and state invariants before releasing an attempt", () => {
  const account = crypto.randomUUID(), folder = "a".repeat(64), key = crypto.randomUUID();
  const row = { id: crypto.randomUUID(), accountId: account, serverFolderId: folder, requestKey: key, accountRevision: 2,
    state: "pending", createdAt: 1793419200, finishedAt: null, errorCode: null, result: null };
  assert.deepEqual(checked(row, account, 2, key, folder), row);
  for (const patch of [{ state: undefined }, { state: "unknown" }, { accountId: crypto.randomUUID() }, { serverFolderId: "b".repeat(64) },
    { requestKey: crypto.randomUUID() }, { accountRevision: 3 }, { result: {} }, { finishedAt: 1 }]) {
    assert.throws(() => checked({ ...row, ...patch }, account, 2, key, folder), error => error.message === "normal_sync_response_invalid");
  }
});
test("unrecognized JSON 4xx and timeouts preserve original operation keys", () => {
  for (const [status, code] of [[408, "request_timeout"], [429, "unknown_rate_limit"], [409, "idempotency_conflict"], [404, "not_found"]]) {
    assert.equal(rejected(new ApiError(status, code)), false);
  }
  assert.equal(rejected(new ApiError(429, "rate_limited")), true);
  assert.equal(rejected(new ApiError(403, "insufficient_scope")), true);
});
