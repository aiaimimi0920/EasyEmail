import assert from "node:assert/strict";
import { test } from "node:test";
import { agentGoogleFixture, entered } from "./agent-google-oauth-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

for (const mutation of ["account", "logout", "supersede", "disconnect", "expiry", "delete"])
  test(`Agent late exchange cannot install after ${mutation}`, async () => {
    const f = await agentGoogleFixture(); let gate, pending;
    try {
      assert.equal((await f.put()).status, 201); const start = expect(await f.start());
      gate = f.hold(); pending = f.complete(new URL(start.authorizationUrl).searchParams.get("state")); await entered(gate);
      if (mutation === "account") expect(await f.put({ ...f.input, expectedRevision: 1, displayName: "Changed during consent" }));
      if (mutation === "logout") expect(await f.write("/api/v1/auth/logout"));
      if (mutation === "supersede") expect(await f.start());
      if (mutation === "disconnect") expect(await f.write(`${f.path}/oauth/google/disconnect`, { expectedRevision: 1 }));
      if (mutation === "expiry") {
        await f.h.db.prepare("UPDATE agent_google_oauth_attempts SET exchange_until=unixepoch()-1").run(); await f.h.scheduled();
      }
      if (mutation === "delete") expect(await f.write(f.path, { expectedRevision: 1 }, undefined, { method: "DELETE" }));
      gate.release(); assert.equal((await pending).status, 409);
      assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_google_oauth_grants").first("n"), 0);
      assert.equal(await f.h.db.prepare("SELECT credential_cipher FROM agent_accounts WHERE id=?").bind(f.id).first("credential_cipher"), null);
      assert.equal(f.opens.length, 0);
    } finally { gate?.release(); await pending; await f.close(); }
  });

for (const mutation of ["account", "disconnect", "reauthorize", "expiry", "owner", "delete"])
  test(`Agent late refresh cannot restore authorization after ${mutation}`, async () => {
    const f = await agentGoogleFixture(); let gate, pending;
    try {
      f.mode("short"); await f.setup(); expect(await f.auto()); f.mode("normal");
      const old = await f.h.db.prepare("SELECT * FROM agent_google_oauth_grants").first();
      gate = f.hold(); pending = f.check(); await entered(gate);
      if (mutation === "account") expect(await f.put({ ...f.input, expectedRevision: 2, displayName: "Changed during refresh", enabled: true }));
      if (mutation === "disconnect") expect(await f.write(`${f.path}/oauth/google/disconnect`, { expectedRevision: 2 }));
      if (mutation === "reauthorize") {
        const started = expect(await f.start(2)); expect(await f.complete(new URL(started.authorizationUrl).searchParams.get("state")));
      }
      if (mutation === "expiry") {
        await f.h.db.prepare("UPDATE agent_google_oauth_grants SET refresh_until=unixepoch()-1 WHERE id=?").bind(old.id).run(); await f.h.scheduled();
      }
      if (mutation === "owner") await f.h.db.prepare("UPDATE users SET status='disabled' WHERE id=?").bind(f.alice.id).run();
      if (mutation === "delete") expect(await f.write(f.path, { expectedRevision: 2 }, undefined, { method: "DELETE" }));
      gate.release(); assert.equal((await pending).status, 409); assert.equal(f.opens.length, 0);
      const grant = await f.h.db.prepare("SELECT * FROM agent_google_oauth_grants WHERE id=?").bind(old.id).first();
      assert.equal(grant.secret_cipher, null); assert.ok(grant.version > old.version);
      if (["account", "disconnect", "reauthorize", "delete"].includes(mutation)) {
        const row = await f.h.db.prepare("SELECT next_due_at,run_token FROM agent_inbox_automation WHERE account_id=?").bind(f.id).first();
        assert.equal(row.next_due_at, null); assert.equal(row.run_token, null);
      }
      if (mutation === "reauthorize") {
        expect(await f.check(3)); assert.equal(f.opens.length, 1);
        assert.equal(expect(await f.h.request(`${f.path}/smtp`, { cookie: f.alice.cookie })).smtp.enabled, false);
        assert.equal(expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config.ready, false);
        expect(await f.auto(3, 1)); assert.equal(expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config.ready, true);
      }
    } finally { gate?.release(); await pending; await f.close(); }
  });

test("old account writers retire bound secrets and invalidate flows without any new columns or OAuth awareness", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); expect(await f.auto()); const started = expect(await f.start(2));
    await f.h.db.prepare("UPDATE agent_accounts SET credential_cipher=NULL,enabled=0,revision=revision+1 WHERE id=?").bind(f.id).run();
    const count = f.calls.length; assert.equal((await f.complete(new URL(started.authorizationUrl).searchParams.get("state"))).status, 409);
    assert.equal(f.calls.length, count); assert.equal(f.opens.length, 0);
    assert.equal(await f.h.db.prepare("SELECT secret_cipher FROM agent_google_oauth_grants").first("secret_cipher"), null);
    const binding = await f.h.db.prepare("SELECT * FROM agent_google_oauth_bindings").first();
    assert.equal(binding.oauth_grant_id, null); assert.equal(binding.oauth_flow_id, null);
  } finally { await f.close(); }
});
