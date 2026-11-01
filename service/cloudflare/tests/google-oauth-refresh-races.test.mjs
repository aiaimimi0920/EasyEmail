import assert from "node:assert/strict";
import { test } from "node:test";
import { googleFixture } from "./google-oauth-fixture.mjs";

const entered = gate => Promise.race([gate.entered, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error("Refresh gate not entered")), 10000); timer.unref(); })]);
for (const mutation of ["expiry", "rename", "delete", "reauthorize"]) test(`late refresh cannot overwrite state after ${mutation}`, async () => {
  const f = await googleFixture(false, true); let gate, pending;
  try {
    f.mode("short"); await f.authorize(); f.mode("normal");
    const oldGrant = await f.h.db.prepare("SELECT * FROM google_oauth_grants").first();
    gate = f.hold(); pending = f.h.request(`${f.path}/test`, { method: "POST", cookie: f.alice.cookie, body: { expectedRevision: 2 } });
    await entered(gate);
    if (mutation === "expiry") {
      await f.h.db.prepare("UPDATE google_oauth_grants SET refresh_until=unixepoch()-1 WHERE id=?").bind(oldGrant.id).run();
      await f.h.scheduled();
    }
    if (mutation === "rename") assert.equal((await f.put({ ...f.input, expectedRevision: 2, displayName: "Changed during refresh", enabled: true })).status, 200);
    if (mutation === "delete") assert.equal((await f.h.request(f.path, { method: "DELETE", cookie: f.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 2 } })).status, 200);
    if (mutation === "reauthorize") {
      const started = await f.start(2); assert.equal(started.status, 200, started.text);
      const completed = await f.complete(new URL(started.body.authorizationUrl).searchParams.get("state"), "synthetic-new-code");
      assert.equal(completed.status, 200, completed.text); assert.equal(completed.body.account.revision, 3);
    }
    gate.release(); const result = await pending; assert.equal(result.status, 409, result.text); assert.equal(f.opens.length, 0);
    const after = await f.h.db.prepare("SELECT * FROM google_oauth_grants WHERE id=?").bind(oldGrant.id).first();
    assert.equal(after.secret_cipher, null); assert.ok(after.version > oldGrant.version);
    assert.equal(after.state, ["expiry", "rename"].includes(mutation) ? "reauthorize" : "disconnected");
    if (mutation === "reauthorize") {
      const active = await f.h.db.prepare("SELECT * FROM google_oauth_grants WHERE state='active'").first();
      assert.notEqual(active.id, oldGrant.id); assert.ok(active.secret_cipher); assert.equal(active.version, 1);
      const checked = await f.h.request(`${f.path}/test`, { method: "POST", cookie: f.alice.cookie, body: { expectedRevision: 3 } });
      assert.equal(checked.status, 200, checked.text); assert.equal(f.opens.length, 1);
    }
  } finally { gate?.release(); await pending; await f.close(); }
});
