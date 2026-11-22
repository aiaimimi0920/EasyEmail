import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readScenario, RAW_MESSAGE } from "./normal-read-fixture.mjs";

let read;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "read-")), outfile = path.join(directory, "read.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-read.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  read = (await import(pathToFileURL(outfile))).readImapBatch;
});
async function batch(scenario, cursor = null) {
  const socket = scenario.socket();
  try { return await read(socket, "Alice", "synthetic-password", cursor); } finally { await socket.close(); }
}
test("bounded UID reads preserve literal bytes and use UID rather than changing sequence numbers", async () => {
  const t = readScenario({ sequence: 2, bodySequence: 1, chunkSize: 1 }), result = await batch(t);
  assert.deepEqual(result.items.map(row => row.uid), [2, 7]);
  assert.deepEqual(result.items[0].raw, RAW_MESSAGE);
  assert.deepEqual(result.cursor, { uidValidity: "42", afterUid: 7 });
  assert.equal(result.complete, true); assert.equal(result.reset, false);
  assert.equal(result.items[0].receivedAt, Date.UTC(2026, 9, 29, 4, 34, 56) / 1000);
  assert.deepEqual(result.items[0].flags, ["\\Seen"]);
  assert.equal(t.calls.some(line => /(?:^| )(?:SELECT|STORE|MOVE|EXPUNGE|APPEND|CLOSE)(?: |$)/.test(line)), false);
  assert.equal(t.calls.filter(line => /BODY/.test(line)).every(line => /BODY.PEEK\[\]/.test(line)), true);
});
test("same-epoch cursor does not refetch older UIDs, while a new UIDVALIDITY resets the scan", async () => {
  const same = readScenario(), next = await batch(same, { uidValidity: "42", afterUid: 2 });
  assert.deepEqual(next.items.map(row => row.uid), [7]); assert.equal(next.reset, false);
  const changed = await batch(readScenario({ validity: "43" }), { uidValidity: "42", afterUid: 200 });
  assert.equal(changed.reset, true); assert.deepEqual(changed.items.map(row => row.uid), [2, 7]);
});
test("read batch caps three messages and never advances past an unprocessed UID", async () => {
  const t = readScenario({ messages: new Map([1, 2, 3, 4, 5].map(uid => [uid, RAW_MESSAGE])), uidNext: 6 });
  const result = await batch(t); assert.equal(result.items.length, 3); assert.equal(result.cursor.afterUid, 3); assert.equal(result.complete, false);
  const next = await batch(readScenario({ messages: t.messages, uidNext: 6 }), result.cursor);
  assert.deepEqual(next.items.map(row => row.uid), [4, 5]); assert.equal(next.complete, true);
});
test("empty UID windows make bounded progress without claiming the full mailbox is synchronized", async () => {
  const result = await batch(readScenario({ messages: new Map(), uidNext: 10001 }));
  assert.deepEqual(result.items, []); assert.equal(result.cursor.afterUid, 100); assert.equal(result.complete, false);
});
test("oversized and concurrently expunged messages are explicit outcomes, not fabricated empty messages", async () => {
  const large = readScenario({ reportedSize: 2 * 1024 * 1024 + 1 }), result = await batch(large);
  assert.equal(result.items.length, 0); assert.deepEqual(result.skipped.map(row => [row.uid, row.reason]), [[2, "message_too_large"], [7, "message_too_large"]]);
  assert.equal(large.calls.some(line => /BODY/.test(line)), false);
  const missing = await batch(readScenario({ disappeared: 2 }));
  assert.deepEqual(missing.skipped, [{ uid: 2, reason: "message_missing" }]); assert.deepEqual(missing.items.map(row => row.uid), [7]);
});
test("binary literals never pass through UTF-8 decoding, even when they contain protocol-looking bytes", async () => {
  const raw = new Uint8Array([...RAW_MESSAGE, 0, 255, 128, 192, 13, 10]);
  const result = await batch(readScenario({ messages: new Map([[2, raw]]), uidNext: 3, chunkSize: 1 }));
  assert.deepEqual(result.items[0].raw, raw);
});
test("malformed cursors fail before acquiring any socket stream", async () => {
  for (const cursor of [{ uidValidity: "0", afterUid: 0 }, { uidValidity: "42", afterUid: -1 }, { uidValidity: "42", afterUid: 0, extra: true }]) {
    await assert.rejects(read({}, "Alice", "synthetic-password", cursor), error => error.code === "invalid_imap_cursor");
  }
});
test("unsolicited flag notifications before and after target FETCH do not become message data", async () => {
  const result = await batch(readScenario({
    metadataResponse: ({ tag, uid, reported }) => [`* 12 FETCH (FLAGS (\\Seen))\r\n* 1 FETCH (UID ${uid} FLAGS () RFC822.SIZE ${reported} INTERNALDATE "29-Oct-2026 12:34:56 +0800")\r\n* 12 FETCH (UID 80 FLAGS ())\r\n${tag} OK metadata\r\n`],
    bodyResponse: ({ tag, uid, raw }) => [`* 1 FETCH (UID ${uid} FLAGS (\\Seen))\r\n* 1 FETCH (UID ${uid} RFC822.SIZE ${raw.length} INTERNALDATE "29-Oct-2026 12:34:56 +0800" FLAGS () BODY[] {${raw.length}}\r\n`, raw, `)\r\n* 12 FETCH (FLAGS ())\r\n${tag} OK body\r\n`],
  }));
  assert.deepEqual(result.items.map(row => row.uid), [2, 7]); assert.deepEqual(result.items[0].raw, RAW_MESSAGE);
});
for (const ending of ["short-literal", "missing-suffix", "missing-completion"]) {
  test(`EOF during ${ending} rejects instead of returning a partial batch`, async () => {
    const t = readScenario({ reportedSize: 100, eofAfterBody: true,
      bodyResponse: () => ["* 1 FETCH (BODY[] {100}\r\n", new Uint8Array(ending === "short-literal" ? 20 : 100),
        ...(ending === "missing-completion" ? [" UID 2 FLAGS () RFC822.SIZE 100 INTERNALDATE \"29-Oct-2026 12:34:56 +0800\")\r\n"] : [])] });
    await assert.rejects(batch(t), error => error.code === "imap_connection_closed");
  });
}
const identity = lines => ({ examineResponse: ({ tag }) => [`* 2 EXISTS\r\n* OK [UIDVALIDITY 42] stable\r\n${lines}${tag} OK [READ-ONLY] done\r\n`] });
for (const [name, options, cursor, code] of [
  ["missing UIDNEXT", { noUidNext: true }, null, "imap_uid_next_missing"],
  ["unstable UIDs", { notSticky: true }, null, "imap_uids_not_sticky"],
  ["UIDNEXT regression", {}, { uidValidity: "42", afterUid: 8 }, "imap_uid_checkpoint_invalid"],
  ["out-of-window search result", { search: [999] }, null, "imap_protocol_invalid"],
  ["duplicate search UID", { search: [2, 2] }, null, "imap_protocol_invalid"],
  ["duplicate UIDNEXT", identity("* OK [UIDNEXT 8] next\r\n* OK [UIDNEXT 9] next\r\n"), null, "imap_uid_next_missing"],
  ["invalid extra UIDNEXT", identity("* OK [UIDNEXT 0] invalid\r\n* OK [UIDNEXT 8] next\r\n"), null, "imap_uid_next_missing"],
  ["invalid date", { metadataResponse: ({ tag, uid, reported }) => [`* 1 FETCH (UID ${uid} FLAGS () RFC822.SIZE ${reported} INTERNALDATE "31-Feb-2026 12:34:56 +0800")\r\n${tag} OK metadata\r\n`] }, null, "imap_protocol_invalid"],
  ["duplicate FETCH identity", { metadataResponse: ({ tag, uid, reported }) => [`* 1 FETCH (UID ${uid} UID ${uid} FLAGS () RFC822.SIZE ${reported} INTERNALDATE "29-Oct-2026 12:34:56 +0800")\r\n${tag} OK metadata\r\n`] }, null, "imap_protocol_invalid"],
  ["only a target flag update", { metadataResponse: ({ tag, uid }) => [`* 1 FETCH (UID ${uid} FLAGS ())\r\n${tag} OK metadata\r\n`] }, null, "imap_protocol_invalid"],
  ["unbounded flag notifications", { metadataResponse: ({ tag }) => ["* 1 FETCH (FLAGS ())\r\n".repeat(100) + `${tag} OK metadata\r\n`] }, null, "imap_response_limit"],
  ["UID mismatch after literal", { bodyResponse: ({ tag, raw }) => [`* 1 FETCH (UID 99 RFC822.SIZE ${raw.length} INTERNALDATE "29-Oct-2026 12:34:56 +0800" FLAGS () BODY[] {${raw.length}}\r\n`, raw, `)\r\n${tag} OK done\r\n`] }, null, "imap_message_changed"],
  ["changed size", { reportedSize: 1 }, null, "imap_message_changed"],
  ["truncated literal", { bodyResponse: ({ tag }) => [`* 1 FETCH (BODY[] {2000000}\r\n${tag} OK not literal completion\r\n`] }, null, "imap_message_changed"],
  ["same-size changed date", { bodyResponse: ({ tag, uid, raw }) => [`* 1 FETCH (UID ${uid} RFC822.SIZE ${raw.length} INTERNALDATE "28-Oct-2026 12:34:56 +0800" FLAGS () BODY[] {${raw.length}}\r\n`, raw, `)\r\n${tag} OK done\r\n`] }, null, "imap_message_changed"],
  ["oversized literal declaration", { bodyResponse: () => ["* 1 FETCH (BODY[] {2097153}\r\n"] }, null, "imap_response_limit"],
]) {
  test(`UID reader refuses ${name}`, async () => {
    await assert.rejects(batch(readScenario(options), cursor), error => error.code === code && !error.message.includes("synthetic-password"));
  });
}
