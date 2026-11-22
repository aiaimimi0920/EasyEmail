import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { googleFixture } from "./google-oauth-fixture.mjs";

const hash = values => createHash("sha256").update(JSON.stringify(values)).digest("hex");
async function catalog(f) {
  const a = await f.h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(f.id).first();
  const source = hash(["normal-server-folders-v1", a.endpoint_hash, a.username, a.email_address]);
  const id = hash(["normal-server-folder-v1", f.id, source, "Sent"]);
  const folders = [{ id, wireName: "Sent", name: "Sent", delimiter: "/", selectable: true, attributes: ["\\Sent"], roles: ["sent"] }];
  await f.h.db.prepare(`INSERT INTO normal_server_folder_catalogs(account_id,source_hash,snapshot_id,snapshot_revision,folders,observed_at)
    VALUES (?,?,?,?,?,unixepoch())`).bind(f.id, source, crypto.randomUUID(), 2, JSON.stringify(folders)).run();
  return `${f.path}/server-folders/${id}`;
}
test("folder OAuth revocation during refresh prevents any IMAP connection and original-key replay stays read-only", async () => {
  const f = await googleFixture(false, true); let gate, pending;
  try {
    f.mode("short"); await f.authorize(); const root = await catalog(f); f.mode("normal");
    const key = crypto.randomUUID(), receive = () => f.h.request(`${root}/sync`, { method: "POST", cookie: f.alice.cookie,
      headers: { "idempotency-key": key }, body: { expectedRevision: 2 } });
    gate = f.hold(); pending = receive(); await gate.entered;
    await f.h.db.prepare("UPDATE google_oauth_grants SET state='disconnected',version=version+1,secret_cipher=NULL").run();
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.body.request.state, "failed", result.text); assert.equal(f.opens.length, 0);
    const calls = f.calls.length; assert.deepEqual((await receive()).body, result.body); assert.equal(f.calls.length, calls);
  } finally { gate?.release(); if (pending) await pending; await f.close(); }
});
test("folder final commit rejects a changed OAuth grant after EXAMINE even when account revision is unchanged", async () => {
  let enter, release; const entered = new Promise(resolve => { enter = resolve; }), waiting = new Promise(resolve => { release = resolve; });
  const f = await googleFixture(false, true, { async onMailWrite(input) { if (/ EXAMINE /.test(input.text)) { enter(); await waiting; } } }); let pending;
  try {
    await f.authorize(); const root = await catalog(f);
    pending = f.h.request(`${root}/sync`, { method: "POST", cookie: f.alice.cookie,
      headers: { "idempotency-key": crypto.randomUUID() }, body: { expectedRevision: 2 } });
    await entered;
    await f.h.db.prepare("UPDATE google_oauth_grants SET state='disconnected',version=version+1,secret_cipher=NULL").run();
    release(); const result = await pending; pending = null;
    assert.equal(result.body.request.state, "failed", result.text);
    assert.equal(await f.h.db.prepare("SELECT COUNT(*) n FROM normal_inbox_messages").first("n"), 0);
    assert.equal((await f.h.db.prepare("SELECT version FROM normal_server_folder_state").first()).version, 0);
  } finally { release(); if (pending) await pending; await f.close(); }
});
