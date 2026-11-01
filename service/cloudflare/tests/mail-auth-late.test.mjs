import assert from "node:assert/strict";
import { test } from "node:test";
import { mailAuthPeer } from "./mail-auth-peer-fixture.mjs";
import { invoke, socketHook } from "./mail-auth-module-fixture.mjs";

const phases = [
  ["imap", { saslIr: false }, / AUTHENTICATE XOAUTH2\r\n$/],
  ["imap", {}, / AUTHENTICATE XOAUTH2 /],
  ["imap", { mode: "error" }, / AUTHENTICATE XOAUTH2 /],
  ["imap", { mode: "error" }, /^\r\n$/],
  ["smtp", {}, /^AUTH XOAUTH2 /],
  ["smtp", { mode: "error" }, /^AUTH XOAUTH2 /],
  ["smtp", { mode: "error" }, /^\r\n$/],
];
for (const readOnly of [false, true]) for (const [protocol, options, pattern] of phases) {
  test(`${protocol} pending ${readOnly ? "read" : "write"} late ${JSON.stringify(options)} ${pattern.source} cannot resume after deadline`, { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = mailAuthPeer(protocol, "starttls", { ...options, lingerClose: true }), gate = p.hold(pattern, readOnly); globalThis[socketHook] = p.connect;
    const outcome = invoke(protocol, "starttls").then(value => ({ value }), error => ({ error }));
    await gate.entered;
    if (readOnly) {
      for (let n = 0; n < 50; n++) await Promise.resolve();
      assert.equal(p.sockets.at(-1).completedWrites.some(text => pattern.test(text)), true);
      assert.equal(p.sockets.at(-1).pendingReads, 1, "the write completed and the client is independently awaiting a response");
    }
    t.mock.timers.tick(15000);
    for (let n = 0; n < 50; n++) await Promise.resolve();
    t.mock.timers.tick(1000); const result = await outcome;
    assert.equal(protocol === "imap" ? result.error?.code : result.value.error, `${protocol}_timeout`);
    const count = p.calls.length; gate.release();
    for (let n = 0; n < 200; n++) await Promise.resolve();
    assert.equal(p.calls.length, count, "late SASL responses cannot disclose a token, acknowledge or enter the inbox/envelope");
    assert.equal(p.sockets.at(-1).closes, 1); assert.equal(p.upgrades, 1);
    for (const socket of p.sockets) assert.equal(socket.readable.locked || socket.writable.locked, false);
  });
}
for (const protocol of ["imap", "smtp"]) test(`${protocol} stalled error acknowledgement remains bounded without retrying credentials`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const p = mailAuthPeer(protocol, "tls", { mode: "error-stall" }); globalThis[socketHook] = p.connect;
  const outcome = invoke(protocol).then(value => ({ value }), error => ({ error }));
  for (let n = 0; n < 500 && !p.calls.some(c => c.text === "\r\n"); n++) await Promise.resolve();
  assert.equal(p.calls.filter(c => c.text === "\r\n").length, 1); t.mock.timers.tick(15000);
  const result = await outcome; assert.equal(protocol === "imap" ? result.error?.code : result.value.error, `${protocol}_timeout`);
  assert.equal(p.credentials.length, 1); assert.equal(p.calls.filter(c => c.address).length, 1);
});
test("SMTP XOAUTH2 final DATA deadline is unknown, never a fresh authorization/send retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const p = mailAuthPeer("smtp", "tls", { final: "stall" }); globalThis[socketHook] = p.connect;
  const outcome = invoke("smtp");
  for (let n = 0; n < 500 && !p.calls.some(c => c.text?.startsWith("Subject:")); n++) await Promise.resolve();
  assert.ok(p.calls.some(c => c.text?.startsWith("Subject:"))); t.mock.timers.tick(15000);
  assert.deepEqual(await outcome, { state: "unknown", error: "smtp_outcome_unknown" }); assert.equal(p.credentials.length, 1);
});
