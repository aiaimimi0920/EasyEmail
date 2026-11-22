import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture } from "./google-oauth-fixture.mjs";
import { mutationScenario } from "./normal-mutation-protocol-fixture.mjs";

async function oauthMutationFixture(options = {}) {
  const f = await googleFixture(false, true, options), scenario = mutationScenario();
  try {
    if (options.short) f.mode("short"); await f.authorize();
    f.mailMode("imap", { after: `AUTH=XOAUTH2 SASL-IR UIDPLUS${options.fallback ? "" : " MOVE"}`, imapScenario: scenario });
    const request = (path, extra = {}) => f.h.request(path, { cookie: f.alice.cookie, ...extra });
    const directory = await request(`${f.path}/server-folders/discover`, { method: "POST", body: { expectedRevision: 2 } });
    assert.equal(directory.status, 200, directory.text);
    const target = directory.body.catalog.items.find(row => row.wireName === "Sent"), root = `${f.path}/server-folders/${target.id}`;
    for (const base of [f.path, root]) {
      const response = await request(`${base}/sync`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 2 } });
      assert.equal(response.body.request.state, "committed", response.text);
    }
    const item = (await request(`${f.path}/messages`)).body.items[0], destination = (await request(`${root}/messages`)).body;
    f.mode("normal");
    return { ...f, scenario, mutate(key = crypto.randomUUID()) { return request(`${f.path}/messages/${item.id}/remote-mutations`, {
      method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 2, epochId: item.epochId, action: "move",
        destinationFolderId: target.id, destinationEpochId: destination.epochId, confirmRemoteChange: true } }); } };
  } catch (error) { await f.close(); throw error; }
}
test("mutation reservation precedes OAuth refresh; revocation blocks all sockets and original-key replay never refreshes again", async () => {
  const f = await oauthMutationFixture({ short: true }), key = crypto.randomUUID(); let gate, pending;
  try {
    gate = f.hold(); const opens = f.opens.length; pending = f.mutate(key); await gate.entered;
    const row = await f.h.db.prepare("SELECT state,dispatched_at FROM normal_remote_mutation_operations WHERE request_key=?").bind(key).first();
    assert.equal(row.state, "pending"); assert.equal(row.dispatched_at, null);
    await f.h.db.prepare("UPDATE google_oauth_grants SET state='disconnected',version=version+1,secret_cipher=NULL").run();
    gate.release(); gate = null; const result = await pending; pending = null;
    assert.equal(result.body.operation.state, "failed", result.text); assert.equal(f.opens.length, opens);
    const calls = f.calls.length; assert.deepEqual((await f.mutate(key)).body, result.body); assert.equal(f.calls.length, calls);
  } finally { gate?.release(); if (pending) await pending; await f.close(); }
});
for (const stage of ["select", "copy"]) test(`OAuth grant is revalidated after ${stage} without cancelling already observed facts`, async () => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const f = await oauthMutationFixture({ fallback: stage === "copy", async onMailWrite(input) {
    if ((stage === "select" ? / SELECT INBOX/ : / UID COPY /).test(input.text)) { enter(); await waiting; }
  } }); let pending;
  try {
    pending = f.mutate(); await entered;
    await f.h.db.prepare("UPDATE google_oauth_grants SET state='disconnected',version=version+1,secret_cipher=NULL").run();
    release(); const result = await pending; pending = null;
    assert.equal(result.body.operation.state, stage === "copy" ? "unknown" : "failed", result.text);
    const writes = f.scenario.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line));
    assert.equal(writes.length, stage === "copy" ? 1 : 0);
    if (stage === "copy") assert.deepEqual(result.body.operation.destination, { uidValidity: "42", uid: 501 });
  } finally { release(); if (pending) await pending; await f.close(); }
});
