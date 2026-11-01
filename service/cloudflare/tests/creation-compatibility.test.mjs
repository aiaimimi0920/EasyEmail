import assert from "node:assert/strict";
import { test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";
import { createHash } from "node:crypto";

test("allocation is accepted by the production self-hosted address creator, not just a synthetic INSERT", async () => {
  const t = await mailboxDeleteFixture();
  try {
    const response = await allocate(t.h, t.alice.cookie);
    assert.equal(response.status, 201, response.text);
    const box = response.body.mailbox, name = box.address.split("@")[0];
    assert.equal(name.length, 27); assert.match(name, /^ee[0-9a-z]{25}$/);
    const stored = await t.f.db.prepare("SELECT * FROM address WHERE name=?").bind(box.address).first(); assert.ok(stored.id > 0);
    const call = t.f.calls.find((call) => call.path === "/cf/admin/new_address"); assert.equal(call.body.name, name);
    assert.equal((await t.h.request(`/api/v1/mailboxes/${box.id}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} })).status, 200);
  } finally { await t.close(); }
});

test("legacy 34-character creation guards replay unchanged across restart without a new name or upstream request", async () => {
  const t = await mailboxDeleteFixture();
  try {
    const hash = createHash("sha256").update(JSON.stringify(["self", "cf.example.test"])).digest("hex");
    const cases = ["pending", "unknown", "complete"].map((state, index) => ({ state, id: crypto.randomUUID(), key: crypto.randomUUID(),
      address: `ee${String(index).repeat(32)}@cf.example.test` }));
    for (const row of cases) {
      await t.h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
        VALUES(?,?,?,?,?,?,123)`).bind(t.alice.id, row.key, hash, row.id, row.address, row.state).run();
      if (row.state === "complete") await t.h.db.prepare(`INSERT INTO mailboxes(id,user_id,provider_id,remote_id,address,status,created_at)
        VALUES(?,?,'self','123',?,'active',123)`).bind(row.id, t.alice.id, row.address).run();
    }
    const before = (await t.h.db.prepare("SELECT * FROM mailbox_creations ORDER BY rowid").all()).results;
    await t.h.restart(); const count = t.f.calls.length;
    for (const row of cases) {
      const response = await allocate(t.h, t.alice.cookie, "self", { headers: { "idempotency-key": row.key } });
      assert.equal(response.status, row.state === "complete" ? 200 : 202, response.text);
      assert.equal((response.body.mailbox ?? response.body.creation).address, row.address);
    }
    assert.equal(t.f.calls.length, count);
    assert.deepEqual((await t.h.db.prepare("SELECT * FROM mailbox_creations ORDER BY rowid").all()).results, before);
  } finally { await t.close(); }
});

test("production creator rejects overlong names and duplicate claims instead of issuing a credential for an existing address", async () => {
  const t = await mailboxDeleteFixture();
  try {
    const create = (name) => fetch(`${t.f.baseUrl}/admin/new_address`, { method: "POST",
      headers: { "content-type": "application/json", "x-admin-auth": "synthetic-cf-admin" },
      body: JSON.stringify({ name, domain: "cf.example.test", enablePrefix: false, enableRandomSubdomain: false }) });
    assert.equal((await create("a".repeat(31))).status, 400);
    assert.equal((await create("a".repeat(30))).status, 200);
    const before = (await t.f.db.prepare("SELECT * FROM address").all()).results;
    assert.equal((await create("a".repeat(30))).status, 400);
    assert.deepEqual((await t.f.db.prepare("SELECT * FROM address").all()).results, before);
    assert.equal((await t.f.db.prepare("SELECT COUNT(*) AS n FROM fixture_credentials").first()).n, 1);
  } finally { await t.close(); }
});
