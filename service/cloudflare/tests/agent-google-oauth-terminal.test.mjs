import assert from "node:assert/strict";
import { test } from "node:test";
import { agentGoogleFixture } from "./agent-google-oauth-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

for (const revision of [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER])
  test(`Agent disconnect remains possible at SMTP revision ${revision}, including original-key replay`, async () => {
    const f = await agentGoogleFixture();
    try {
      await f.setup(); expect(await f.auto());
      await f.h.db.prepare("UPDATE agent_smtp_configs SET revision=? WHERE account_id=?").bind(revision, f.id).run();
      const key = crypto.randomUUID(), disconnect = () => f.write(`${f.path}/oauth/google/disconnect`, { expectedRevision: 2 }, key);
      expect(await disconnect()); assert.equal(expect(await disconnect()).replayed, true);
      assert.equal(await f.h.db.prepare("SELECT secret_cipher FROM agent_google_oauth_grants").first("secret_cipher"), null);
      const smtp = await f.h.db.prepare("SELECT credential_cipher,enabled,revision FROM agent_smtp_configs").first();
      assert.deepEqual(smtp, { credential_cipher: null, enabled: 0, revision: Number.MAX_SAFE_INTEGER });
      assert.equal(expect(await f.h.request(`${f.path}/auto-inbox`, { cookie: f.alice.cookie })).config.ready, false);
    } finally { await f.close(); }
  });

test("Agent reauthorization can reach terminal account revision but terminal revocation still clears all authority", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); await f.h.db.prepare("UPDATE agent_accounts SET revision=? WHERE id=?").bind(Number.MAX_SAFE_INTEGER - 1, f.id).run();
    await f.h.db.prepare("UPDATE agent_smtp_configs SET revision=? WHERE account_id=?").bind(Number.MAX_SAFE_INTEGER, f.id).run();
    const started = expect(await f.start(Number.MAX_SAFE_INTEGER - 1));
    const done = expect(await f.complete(new URL(started.authorizationUrl).searchParams.get("state"))); assert.equal(done.account.revision, Number.MAX_SAFE_INTEGER);
    assert.equal((await f.start(Number.MAX_SAFE_INTEGER)).status, 400);
    const disconnected = expect(await f.write(`${f.path}/oauth/google/disconnect`, { expectedRevision: Number.MAX_SAFE_INTEGER }));
    assert.equal(disconnected.account.revision, Number.MAX_SAFE_INTEGER); assert.equal(disconnected.account.enabled, false);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_google_oauth_grants WHERE secret_cipher IS NOT NULL").first("n"), 0);
  } finally { await f.close(); }
});

test("Agent disconnect receipt history limit cannot prevent local revocation", async () => {
  const f = await agentGoogleFixture();
  try {
    await f.setup(); await f.h.db.prepare(`WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<10000)
      INSERT INTO agent_google_oauth_disconnects(id,user_id,account_id,request_key,request_hash,revision,created_at)
      SELECT 'quota-'||x,?,?,'quota-'||x,'synthetic',2,0 FROM n`).bind(f.alice.id, f.id).run();
    expect(await f.write(`${f.path}/oauth/google/disconnect`, { expectedRevision: 2 }));
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM agent_google_oauth_grants WHERE secret_cipher IS NOT NULL").first("n"), 0);
  } finally { await f.close(); }
});
