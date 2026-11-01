import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime, endpoints, message, socketHook } from "./starttls-module-fixture.mjs";
import { starttlsPeer } from "./starttls-peer-fixture.mjs";

function socket(text) {
  return { opened: Promise.resolve(), closed: Promise.resolve(), close: async () => {},
    readable: new ReadableStream({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } }),
    writable: new WritableStream({ write() {} }) };
}
for (const protocol of ["imap", "smtp"]) test(`${protocol} upgrade keeps the cumulative pre/post-TLS byte budget`, async () => {
  const chunks = protocol === "imap" ? ["* OK " + "x".repeat(8000) + "\r\n", "* OK " + "y".repeat(8000) + "\r\n"]
    : ["250-" + "x".repeat(500) + "\r\n", "250-" + "y".repeat(500) + "\r\n"];
  const plain = socket(chunks[0].repeat(protocol === "imap" ? 5 : 80) + (protocol === "smtp" ? "250 done\r\n" : ""));
  const secure = socket(chunks[1].repeat(protocol === "imap" ? 4 : 64) + (protocol === "smtp" ? "250 done\r\n" : ""));
  const control = { assertActive() {}, upgrade() { assert.equal(plain.readable.locked, false); return secure; } };
  const wire = protocol === "imap" ? new runtime.ImapWire(plain, 65536, control) : new runtime.SmtpWire(plain, control);
  try {
    if (protocol === "imap") for (let n = 0; n < 5; n++) await wire.line(); else await wire.reply();
    await wire.startTls();
    await assert.rejects(protocol === "imap" ? wire.line() : wire.reply(), { code: `${protocol}_response_limit` });
  } finally { wire.release(); }
});
for (const protocol of ["imap", "smtp"]) test(`${protocol} stalled secure close is bounded and does not undo success`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = starttlsPeer(protocol, "close-stall"); globalThis[socketHook] = p.connect;
  const pending = protocol === "imap" ? runtime.testImapConnection(endpoints.imap, "Alice", "synthetic") : runtime.sendSmtp(endpoints.smtp, "Alice", "synthetic", message);
  for (let n = 0; n < 500 && !p.sockets[1]?.closes; n++) await Promise.resolve();
  assert.equal(p.sockets[1]?.closes, 1); t.mock.timers.tick(1000);
  const result = await pending; assert.equal(protocol === "imap" ? result.authenticated : result.state, protocol === "imap" ? true : "accepted");
});
test("SMTP TLS final response deadline stays unknown after DATA, with one close and no reconnect", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const p = starttlsPeer("smtp", "stall-final"); globalThis[socketHook] = p.connect;
  const pending = runtime.sendSmtp(endpoints.smtp, "Alice", "synthetic", message);
  for (let n = 0; n < 500 && !p.calls.some(c => c.text === message.mime); n++) await Promise.resolve();
  assert.ok(p.calls.some(c => c.text === message.mime)); t.mock.timers.tick(15000);
  assert.deepEqual(await pending, { state: "unknown", error: "smtp_outcome_unknown" });
  assert.equal(p.sockets[1].closes, 1); assert.equal(p.calls.filter(c => c.address).length, 1);
});
test("replacement closed rejection is observed and cannot retract a definitive final 250", async () => {
  const p = starttlsPeer("smtp", "closed-reject"); globalThis[socketHook] = p.connect;
  assert.equal((await runtime.sendSmtp(endpoints.smtp, "Alice", "synthetic", message)).state, "accepted");
  // A closed notification cannot retract a definitive 250; opened failures are separately fail-closed.
  assert.equal(p.sockets[1].closes, 1);
});
