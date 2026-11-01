import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime, endpoints, message, socketHook } from "./starttls-module-fixture.mjs";
import { starttlsPeer } from "./starttls-peer-fixture.mjs";

const phases = { imap: [["plain", / STARTTLS\r\n$/], ["tls", / CAPABILITY\r\n$/], ["tls", / AUTHENTICATE PLAIN\r\n$/]],
  smtp: [["plain", /^STARTTLS\r\n$/], ["tls", /^EHLO /], ["tls", /^AUTH PLAIN /]] };
for (const protocol of ["imap", "smtp"]) for (const [stage, pattern] of phases[protocol]) {
  test(`${protocol} late ${stage} ${pattern.source} cannot advance after deadline even when close never settles I/O`, { timeout: 5000 }, async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const p = starttlsPeer(protocol, "linger-close"), gate = p.hold(stage, pattern); globalThis[socketHook] = p.connect;
    const pending = protocol === "imap" ? runtime.testImapConnection(endpoints.imap, "Alice", "synthetic-secret")
      : runtime.sendSmtp(endpoints.smtp, "Alice", "synthetic-secret", message);
    const outcome = pending.then(value => ({ value }), error => ({ error }));
    await gate.entered; t.mock.timers.tick(15000);
    for (let n = 0; n < 50; n++) await Promise.resolve();
    t.mock.timers.tick(1000);
    const result = await outcome;
    assert.equal(protocol === "imap" ? result.error?.code : result.value.error, `${protocol}_timeout`);
    const count = p.calls.length, upgrades = p.upgrades; gate.release();
    for (let n = 0; n < 200; n++) await Promise.resolve();
    assert.equal(p.calls.length, count); assert.equal(p.upgrades, upgrades);
    assert.equal(p.sockets.at(-1).closes, 1);
    for (const socket of p.sockets) assert.equal(socket.readable.locked || socket.writable.locked, false);
  });
}
