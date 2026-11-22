import assert from "node:assert/strict";
import { test } from "node:test";
import { adminFixture, ok } from "./admin-fixture.mjs";
import { allocate, cfMail } from "./provider-fixture.mjs";
import { sendCalls, sendRequest } from "./send-fixture.mjs";

test("configuration CAS has one winner and audit, and audit failure rolls the entire write back", async () => {
  const a = await adminFixture(), { h, admin } = a;
  try {
    const config = (await a.current()).config;
    const save = (enabled) => h.request("/api/v1/admin/providers/self", { cookie: admin.cookie, method: "PUT",
      body: { expectedRevision: 0, config: { ...config, enabled }, secretAction: "clear" } });
    const results = await Promise.all([save(false), save(true)]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit").first()).n, 1);
    const before = await h.db.prepare("SELECT * FROM provider_overrides WHERE id = 'self'").first();
    await h.db.prepare("CREATE TRIGGER fail_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END").run();
    try { assert.equal((await a.save({ enabled: true })).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_admin_audit").run(); }
    assert.deepEqual(await h.db.prepare("SELECT * FROM provider_overrides WHERE id = 'self'").first(), before);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit").first()).n, 1);
  } finally { await a.close(); }
});

test("domain request racing a configuration change cannot acquire a new allocation guard", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    gate = f.hold("/v3/domains");
    const pending = allocate(h, alice.cookie, "temporam");
    try { await gate.entered; ok(await a.save({ enabled: false }, "temporam")); }
    finally { gate.release(); }
    assert.equal((await pending).body.error.code, "provider_config_changed");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailbox_creations").first()).n, 0);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM mailboxes").first()).n, 0);
  } finally { gate?.release(); await a.close(); }
});

test("reserved sends and sync may finish, disabled providers block new work without erasing cache or replay guards", async () => {
  const a = await adminFixture(), { h, f, alice } = a;
  let gate;
  try {
    const box = ok(await allocate(h, alice.cookie), 201).mailbox, key = crypto.randomUUID();
    gate = f.hold("/cf/admin/send_mail_by_binding");
    const pending = sendRequest(h, alice.cookie, box, key);
    try { await gate.entered; ok(await a.save({ enabled: false })); }
    finally { gate.release(); }
    assert.equal((await pending).body.outgoing.state, "accepted");
    assert.equal((await sendRequest(h, alice.cookie, box, key)).body.outgoing.state, "accepted");
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID())).body.error.code, "provider_disabled");
    assert.equal(sendCalls(f).length, 1);
    ok(await a.save({ enabled: true }));
    f.messages.set(box.address, [cfMail(box.address, 1)]);
    gate = f.hold("/cf/api/parsed_mails");
    const sync = () => h.request(`/api/v1/mailboxes/${box.id}/sync`, { cookie: alice.cookie, method: "POST", body: {} });
    const syncing = sync();
    try { await gate.entered; ok(await a.save({ enabled: false })); }
    finally { gate.release(); }
    ok(await syncing);
    assert.equal((await sync()).body.error.code, "provider_disabled");
    assert.equal((await h.request(`/api/v1/mailboxes/${box.id}/messages`, { cookie: alice.cookie })).body.items.length, 1);
  } finally { gate?.release(); await a.close(); }
});

test("probe cannot publish stale health after configuration changes and health/audit storage is atomic", async () => {
  const a = await adminFixture(), { h, f } = a;
  let gate;
  try {
    gate = f.hold("/cf/admin/worker/configs");
    const pending = a.probe();
    try { await gate.entered; ok(await a.save({ enabled: false })); }
    finally { gate.release(); }
    assert.equal((await pending).body.error.code, "provider_config_changed");
    assert.equal((await a.current()).health.state, "unknown");
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit WHERE action = 'probe'").first()).n, 0);
    await h.db.prepare("CREATE TRIGGER fail_probe_audit BEFORE INSERT ON admin_audit WHEN NEW.action = 'probe' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END").run();
    try { assert.equal((await a.probe()).status, 500); }
    finally { await h.db.prepare("DROP TRIGGER fail_probe_audit").run(); }
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM provider_health").first()).n, 0);
    ok(await a.probe()); await h.restart();
    assert.equal((await a.current()).health.state, "ok");
  } finally { gate?.release(); await a.close(); }
});

test("provider limit is atomic for competing new instances and does not block editing baseline instances", async () => {
  const a = await adminFixture(), { h, admin } = a;
  try {
    const config = (await a.current()).config;
    for (let i = 0; i < 17; i++) {
      const id = `seed-${i}`;
      await h.db.prepare(`INSERT INTO provider_overrides(id,config_json,revision,secret_source,secret_cipher,change_token,updated_at)
        VALUES (?,?,1,'none',NULL,?,123)`).bind(id, JSON.stringify({ ...config, id, enabled: false }), crypto.randomUUID()).run();
    }
    const insert = (id) => h.request(`/api/v1/admin/providers/${id}`, { cookie: admin.cookie, method: "PUT", body: {
      expectedRevision: 0, config: { ...config, id, enabled: false }, secretAction: "keep" } });
    const results = await Promise.all([insert("competing-a"), insert("competing-b")]);
    assert.deepEqual(results.map((row) => row.status).sort(), [200, 409]);
    assert.equal((await a.list()).body.items.length, 20);
    assert.equal((await h.db.prepare("SELECT COUNT(*) n FROM admin_audit").first()).n, 1);
    ok(await a.save({ enabled: false }));
    assert.equal((await a.list()).body.items.length, 20);
    assert.equal((await insert("over-limit")).body.error.code, "provider_limit");
  } finally { await a.close(); }
});
