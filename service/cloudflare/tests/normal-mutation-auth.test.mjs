import assert from "node:assert/strict";
import { test } from "node:test";
import { mailAuthPeer } from "./mail-auth-peer-fixture.mjs";
import { mutationScenario } from "./normal-mutation-protocol-fixture.mjs";
import { runtime, authentication, endpoint, password, socketHook, token, username } from "./mail-auth-module-fixture.mjs";

const command = { uid: 2, uidValidity: "42", action: "move" };
function fixture(security = "tls", options = {}) {
  const scenario = mutationScenario(), peer = mailAuthPeer("imap", security, {
    after: "AUTH=PLAIN AUTH=XOAUTH2 SASL-IR MOVE UIDPLUS", imapScenario: scenario, ...options,
  });
  globalThis[socketHook] = peer.connect;
  return { scenario, peer, run(input = command, credential = authentication, before = async () => {}) {
    return runtime.writeImapMutation(endpoint("imap", security), username, credential, input, before, "Sent", "INBOX");
  } };
}
const writes = scenario => scenario.calls.filter(line => / UID (?:MOVE|COPY|STORE|EXPUNGE) /.test(line));
for (const security of ["tls", "starttls"]) for (const credential of [authentication, password]) {
  test(`mutation ${security} preserves explicit ${typeof credential === "string" ? "PLAIN" : "XOAUTH2"} and stream ownership`, async () => {
    const f = fixture(security), result = await f.run(command, credential);
    assert.equal(result.method, "move"); assert.equal(f.peer.calls.filter(call => call.address).length, 1);
    assert.equal(f.peer.upgrades, Number(security === "starttls")); assert.equal(f.peer.sockets.at(-1).closes, 1);
    assert.equal(f.peer.sockets.some(socket => socket.readable.locked || socket.writable.locked), false);
    assert.deepEqual(f.peer.credentials, [typeof credential === "string" ? { method: "PLAIN", value: `\0${username}\0${password}` }
      : { method: "XOAUTH2", value: `user=${username}\x01auth=Bearer ${token}\x01\x01` }]);
    assert.ok(f.peer.calls.filter(call => call.text?.includes("AUTHENTICATE")).every(call => call.stage === "tls"));
    assert.equal(writes(f.scenario).length, 1);
  });
}
for (const security of ["tls", "starttls"]) for (const mode of ["reject", "error", "error-ok", "double-error"]) {
  test(`mutation ${security} XOAUTH2 ${mode} never downgrades, retries, opens a folder or runs a fence`, async () => {
    const f = fixture(security, { mode }); let dispatched = false;
    await assert.rejects(f.run(command, authentication, async () => { dispatched = true; }), error => error.code === "imap_auth_failed"
      && !error.message.includes(token) && !error.message.includes("synthetic-private-error"));
    assert.equal(dispatched, false); assert.deepEqual(f.scenario.calls, []); assert.equal(f.peer.credentials.length, 1);
    assert.equal(f.peer.credentials[0].method, "XOAUTH2"); assert.equal(f.peer.sockets.at(-1).closes, 1);
    assert.equal(f.peer.calls.filter(call => call.address).length, 1);
  });
}
test("mutation STARTTLS missing upgrade capability fails before credentials or side effects", async () => {
  const f = fixture("starttls", { before: "AUTH=PLAIN AUTH=XOAUTH2" });
  await assert.rejects(f.run(), error => error.code === "imap_starttls_unavailable");
  assert.deepEqual(f.peer.credentials, []); assert.deepEqual(f.scenario.calls, []); assert.equal(f.peer.upgrades, 0);
});
test("mutation XOAUTH2 absent after upgrade never uses the earlier capability or PLAIN", async () => {
  const f = fixture("starttls", { after: "AUTH=PLAIN MOVE UIDPLUS" });
  await assert.rejects(f.run(), error => error.code === "imap_auth_method_unavailable");
  assert.deepEqual(f.peer.credentials, []); assert.deepEqual(f.scenario.calls, []); assert.equal(f.peer.upgrades, 1);
});
test("mutation without SASL-IR sends one bearer response before selecting the exact source", async () => {
  const f = fixture("starttls", { after: "AUTH=XOAUTH2 MOVE UIDPLUS" });
  assert.equal((await f.run()).method, "move"); assert.equal(f.peer.credentials.length, 1);
  assert.equal(f.peer.calls.find(call => call.text?.includes("AUTHENTICATE")).text.trimEnd().split(" ").length, 3);
});
test("validated command is snapshotted before socket awaits and cannot change its UID in flight", async () => {
  const f = fixture(), input = { ...command }, gate = f.peer.hold(/CAPABILITY/);
  const pending = f.run(input);
  try {
    await gate.entered; input.uid = 999; input.action = "delete"; input.uidValidity = "43"; gate.release();
    assert.equal((await pending).method, "move"); assert.match(writes(f.scenario)[0], / UID MOVE 2 INBOX$/);
  } finally { gate.release(); }
});
