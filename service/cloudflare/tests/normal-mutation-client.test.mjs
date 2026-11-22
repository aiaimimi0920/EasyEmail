import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { normalMutationFixture } from "./normal-mutation-runtime-fixture.mjs";

const writes = fixture => fixture.calls.filter(line => / UID (?:MOVE|COPY|STORE|EXPUNGE) /.test(line));
test("workerd mutation uses one TLS socket and closes it after source removal and destination mapping", async () => {
  const f = await normalMutationFixture();
  try {
    const response = await f.mutate(); assert.equal(response.status, 200, response.text);
    assert.deepEqual(response.body.result, { method: "move", sourceRemoved: true, destination: { uidValidity: "42", uid: 501 } });
    assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1);
    assert.deepEqual(f.opens[0], { address: { hostname: "imap.example.test", port: 993 }, options: { secureTransport: "on", allowHalfOpen: false } });
    assert.deepEqual(f.phases, [{ phase: "move" }]); assert.equal(writes(f).length, 1);
  } finally { await f.close(); }
});
test("workerd fallback forwards the verified COPYUID to both later fences and preserves unrelated messages", async () => {
  const f = await normalMutationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" });
  try {
    f.deleted.add("Sent:999"); f.mailboxes.get("Sent").messages.set(999, new Uint8Array([1]));
    const response = await f.mutate(); assert.equal(response.status, 200, response.text);
    assert.deepEqual(f.phases, [{ phase: "copy" }, ...["mark-deleted", "expunge"].map(phase => ({ phase, destination: { uidValidity: "42", uid: 501 } }))]);
    assert.ok(f.mailboxes.get("Sent").messages.has(999)); assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1);
  } finally { await f.close(); }
});
test("invalid command, authentication, folder or absent fence is rejected before any socket", async () => {
  const f = await normalMutationFixture();
  try {
    for (const [body, status] of [[{ command: { uid: 0 } }, 400], [{ username: "Alice\r\ninjected" }, 400], [{ authentication: "" }, 400],
      [{ source: "Sent\nEXPUNGE" }, 502], [{ destination: "Sent" }, 400], [{ omitFence: true }, 400]]) {
      const response = await f.mutate(body); assert.equal(response.status, status, response.text);
    }
    assert.equal(f.opens.length, 0); assert.deepEqual(f.calls, []);
  } finally { await f.close(); }
});
for (const phase of ["copy", "mark-deleted", "expunge"]) test(`workerd revoked ${phase} fence cannot send its next command`, async () => {
  const f = await normalMutationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", rejectPhase: phase });
  try {
    const response = await f.mutate(); assert.equal(response.status, 409, response.text);
    assert.equal(response.body.error.code, "remote_mutation_target_changed"); assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1);
    assert.equal(writes(f).length, ["copy", "mark-deleted", "expunge"].indexOf(phase));
  } finally { await f.close(); }
});
test("workerd response loss after MOVE never reconnects, retries, compensates or leaks credentials", async () => {
  const f = await normalMutationFixture({ failAfterCommand: / UID MOVE / });
  try {
    const response = await f.mutate(); assert.equal(response.status, 502, response.text);
    assert.deepEqual(response.body, { error: { code: "imap_connection_failed" } });
    assert.equal(f.mailboxes.get("Sent").messages.has(2), false); assert.ok(f.mailboxes.get("&Ti1lhw-").messages.has(501));
    assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1); assert.equal(writes(f).length, 1);
  } finally { await f.close(); }
});
test("workerd open failure is sanitized and still closes the only socket", async () => {
  const f = await normalMutationFixture({ connectionFailure: true });
  try {
    const response = await f.mutate(); assert.equal(response.status, 502, response.text);
    assert.equal(response.body.error.code, "imap_connection_failed"); assert.equal(f.closes.length, 1); assert.equal(writes(f).length, 0);
  } finally { await f.close(); }
});
test("workerd one deadline fences a late callback after COPY without STORE, reconnect or retry", async () => {
  const f = await normalMutationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" });
  const gate = f.holdPhase("mark-deleted");
  try {
    const started = Date.now(), pending = f.mutate(); await gate.entered;
    const response = await pending; assert.equal(response.status, 504, response.text); assert.equal(response.body.error.code, "imap_timeout");
    assert.ok(Date.now() - started >= 14500 && Date.now() - started < 20000);
    gate.release(); await delay(200);
    assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1); assert.equal(writes(f).length, 1);
    assert.ok(f.mailboxes.get("Sent").messages.has(2)); assert.ok(f.mailboxes.get("&Ti1lhw-").messages.has(501));
  } finally { gate.release(); await f.close(); }
});
test("workerd bounded socket cleanup cannot turn a confirmed remote mutation into another dispatch", async () => {
  const f = await normalMutationFixture(), gate = f.holdClose();
  try {
    const pending = f.mutate(); await gate.entered; const response = await pending;
    assert.equal(response.status, 200, response.text); assert.equal(f.opens.length, 1); assert.equal(f.closes.length, 1); assert.equal(writes(f).length, 1);
  } finally { gate.release(); await f.close(); }
});
