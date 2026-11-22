import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let adapter, api;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mutation-adapter-")), outfile = path.join(directory, "adapter.mjs");
  await build({ stdin: { contents: 'export * from "./normal-remote-mutations"; export { ApiError } from "./api";',
    resolveDir: fileURLToPath(new URL("../web", import.meta.url)) }, outfile, bundle: true, format: "esm", platform: "neutral" });
  adapter = await import(pathToFileURL(outfile)); api = adapter.ApiError;
});
const message = { accountId: crypto.randomUUID(), id: crypto.randomUUID(), accountRevision: 1, epochId: crypto.randomUUID(), uid: 2 };
const folder = { id: "a".repeat(64), wireName: "Sent", name: "Sent", selectable: true, delimiter: "/", attributes: [], roles: [] };
const inbox = { ...folder, id: "b".repeat(64), wireName: "INBOX", name: "INBOX" };
const catalog = { accountId: message.accountId, accountRevision: 1, current: true, complete: true, snapshotId: crypto.randomUUID(),
  snapshotAccountRevision: 1, observedAt: 100, items: [folder, inbox, { ...folder, id: "c".repeat(64), wireName: "Container", selectable: false }] };
async function withFetch(handler, run) {
  const original = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url, options }); return Response.json(await handler(url, options)); };
  try { await run(calls); } finally { globalThis.fetch = original; }
}
test("only exact pre-reservation errors permit release; storage, conflicts, malformed receipts and network failures retain key", () => {
  assert.equal(adapter.remoteMutationRejectedBeforeReservation(new api(409, "remote_write_target_busy")), true);
  assert.equal(adapter.remoteMutationRejectedBeforeReservation(new api(429, "rate_limited")), true);
  for (const failure of [new api(503, "remote_mutation_storage_unknown"), new api(409, "remote_mutation_changed_or_limit"),
    new api(409, "idempotency_conflict"), new api(502, "remote_mutation_response_invalid"), new api(500, "remote_write_target_busy"),
    new api(404, "rate_limited"), new TypeError("fetch failed")]) assert.equal(adapter.remoteMutationRejectedBeforeReservation(failure), false);
});
test("target catalog reads exclude source and noselect, require exact account and never discover or sync", async () => {
  await withFetch(url => url.endsWith("server-folders") ? { catalog } : { account: { id: message.accountId, revision: 1, enabled: true, deleted: false } }, async calls => {
    const signal = new AbortController().signal;
    assert.deepEqual(await adapter.mutationDestinationFolders(message, signal), [folder]);
    assert.deepEqual(await adapter.mutationDestinationFolders({ ...message, serverFolderId: folder.id }, signal), [inbox]);
    assert.equal(calls.length, 4); assert.ok(calls.every(call => call.options.method === "GET" && !/discover|sync/.test(call.url) && call.options.signal === signal));
  });
  await withFetch(() => ({ account: { id: crypto.randomUUID(), revision: 1, enabled: true, deleted: false } }), async calls => {
    await assert.rejects(adapter.mutationDestinationFolders(message, new AbortController().signal), /remote_mutation_target_changed/); assert.equal(calls.length, 1);
  });
});
test("destination epoch is read from exact folder, canonical INBOX and current ready cache only", async () => {
  const epochId = crypto.randomUUID(), signal = new AbortController().signal;
  await withFetch(() => ({ accountRevision: 1, sourceReady: true, epochId }), async calls => {
    assert.equal(await adapter.mutationDestinationEpoch(message, folder, signal), epochId);
    assert.equal(await adapter.mutationDestinationEpoch(message, inbox, signal), epochId);
    assert.ok(calls[0].url.endsWith(`/server-folders/${folder.id}/messages?limit=1`));
    assert.ok(calls[1].url.endsWith(`/${message.accountId}/messages?limit=1`));
    assert.ok(calls.every(call => call.options.method === "GET" && call.options.signal === signal));
  });
  for (const row of [{ accountRevision: 2, sourceReady: true, epochId }, { accountRevision: 1, sourceReady: false, epochId },
    { accountRevision: 1, sourceReady: true, epochId: null }, { accountRevision: 1, sourceReady: true, epochId: "not-epoch" }]) {
    await withFetch(() => row, async () => { await assert.rejects(adapter.mutationDestinationEpoch(message, folder, signal), /remote_mutation_destination_sync_required/); });
  }
});
