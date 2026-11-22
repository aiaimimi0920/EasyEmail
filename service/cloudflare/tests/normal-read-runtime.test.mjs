import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { normalReadFixture } from "./normal-read-runtime-fixture.mjs";
import { RAW_MESSAGE } from "./normal-read-fixture.mjs";
import { ATTACHMENT, multipartMessage } from "./normal-mime-fixture.mjs";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
test("workerd executes the native TLS batch client and MIME mapping without losing binary literal bytes", async () => {
  const raw = new Uint8Array([...RAW_MESSAGE, 0, 255, 128, 192]), t = await normalReadFixture({ messages: new Map([[2, raw]]), uidNext: 3 });
  try {
    const result = await t.read(); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.items[0].rawSha256, sha256(raw)); assert.equal(result.body.items[0].bytes, raw.length);
    assert.equal(result.body.items[0].content.recipient, "alice@example.test");
    assert.deepEqual(result.body.cursor, { uidValidity: "42", afterUid: 2 });
    assert.deepEqual(t.opens, [{ address: { hostname: "imap.example.test", port: 993 }, options: { secureTransport: "on", allowHalfOpen: false } }]);
    assert.equal(t.closes.length, 1);
    assert.equal(t.calls.some(line => /(?:^| )(?:SELECT|STORE|MOVE|EXPUNGE|APPEND|CLOSE)(?: |$)/.test(line)), false);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM messages").first("n"), 0, "Reader is not a durable synchronization endpoint");
  } finally { await t.close(); }
});
test("workerd maps a MIME attachment using its decoded-byte digest", async () => {
  const raw = multipartMessage(), t = await normalReadFixture({ messages: new Map([[1, raw]]), uidNext: 2 });
  try {
    const result = await t.read(); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.items[0].content.attachments[0].sha256, sha256(ATTACHMENT));
    assert.equal(result.body.items[0].content.attachments[0].size, ATTACHMENT.length); assert.equal(t.closes.length, 1);
  } finally { await t.close(); }
});
test("native read client rejects an invalid cursor before opening a socket", async () => {
  const t = await normalReadFixture();
  try {
    const result = await t.read({ uidValidity: "42", afterUid: -1 }); assert.equal(result.status, 400, result.text);
    assert.equal(result.body.error.code, "invalid_imap_cursor"); assert.equal(t.opens.length, 0); assert.equal(t.closes.length, 0);
  } finally { await t.close(); }
});
test("maximum allowed RFC822 literal works under workerd and oversized metadata never requests a body", async () => {
  const raw = new Uint8Array(2 * 1024 * 1024).fill(120);
  raw.set(new TextEncoder().encode("From: sender@example.test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n"));
  const t = await normalReadFixture({ messages: new Map([[1, raw]]), uidNext: 2 });
  try {
    const result = await t.read(); assert.equal(result.status, 200, result.text.slice(0, 1000));
    assert.equal(result.body.items[0].bytes, raw.length); assert.equal(result.body.items[0].rawSha256, sha256(raw));
  } finally { await t.close(); }
  const large = await normalReadFixture({ reportedSize: raw.length + 1 });
  try {
    const result = await large.read(); assert.equal(result.status, 200, result.text);
    assert.equal(result.body.items.length, 0); assert.equal(result.body.skipped.length, 2);
    assert.equal(large.calls.some(line => /BODY/.test(line)), false); assert.equal(large.closes.length, 1);
  } finally { await large.close(); }
});
test("native read client closes on protocol failure and never returns a partial successful batch", async () => {
  const t = await normalReadFixture({ bodyResponse: ({ tag, raw }) => [`* 1 FETCH (UID 99 RFC822.SIZE ${raw.length} INTERNALDATE "29-Oct-2026 12:34:56 +0800" FLAGS () BODY[] {${raw.length}}\r\n`, raw, `)\r\n${tag} OK done\r\n`] });
  try {
    const result = await t.read(); assert.equal(result.status, 502, result.text);
    assert.equal(result.body.error.code, "imap_message_changed"); assert.equal("items" in result.body, false);
    assert.equal(result.text.includes("Synthetic-reader-password"), false); assert.equal(t.closes.length, 1);
  } finally { await t.close(); }
});
test("a rejected TCP open is sanitized and still closes its owned socket", async () => {
  const t = await normalReadFixture({ connectionFailure: true });
  try {
    const result = await t.read(); assert.equal(result.status, 502, result.text);
    assert.equal(result.body.error.code, "imap_connection_failed"); assert.equal(result.text.includes("private-transport-error"), false);
    assert.equal(t.opens.length, 1); assert.equal(t.closes.length, 1);
  } finally { await t.close(); }
});
test("a stalled socket close cannot hang a completed read indefinitely", async () => {
  const t = await normalReadFixture(), gate = t.holdClose(); let pending;
  try {
    const started = Date.now(); pending = t.read();
    const result = await pending; pending = null;
    assert.equal(result.status, 200, result.text); assert.equal(t.closes.length, 1);
    assert.ok(Date.now() - started >= 900); assert.ok(Date.now() - started < 5000);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
test("read timeout bounds the whole exchange and closes the in-flight socket exactly once", async () => {
  const t = await normalReadFixture(), gate = t.holdBody(); let pending;
  try {
    const started = Date.now(); pending = t.read(); await gate.entered;
    const result = await pending; pending = null;
    assert.equal(result.status, 504, result.text); assert.equal(result.body.error.code, "imap_timeout");
    assert.equal(t.closes.length, 1); assert.ok(Date.now() - started >= 14000); assert.ok(Date.now() - started < 23000);
    gate.release(); assert.equal((await t.read()).status, 200);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});
