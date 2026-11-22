import assert from "node:assert/strict";
import { test } from "node:test";
import { mailboxDeleteFixture } from "./mailbox-delete-fixture.mjs";
import { createHash } from 'node:crypto';

const body = (prefix) => ({ providerId: "self", domain: "cf.example.test", prefix });
const write = (t, input, key = crypto.randomUUID(), cookie = t.alice.cookie) => t.h.request("/api/v1/mailboxes",
  { method: "POST", cookie, body: input, headers: { "idempotency-key": key } });
const customWrites = (t) => t.f.calls.filter((call) => call.path === "/cf/admin/custom_address" && call.method === "POST");

test("custom prefix creates an exact address through the production constrained endpoint and replays without another write", async () => {
  const t = await mailboxDeleteFixture();
  try {
    const key = crypto.randomUUID(), input = body("chosen123"), response = await write(t, input, key);
    assert.equal(response.status, 201, response.text); assert.equal(response.body.mailbox.address, "chosen123@cf.example.test");
    const stored = await t.f.db.prepare("SELECT id FROM address WHERE name=?").bind(response.body.mailbox.address).first(); assert.ok(stored.id > 0);
    assert.equal((await write(t, input, key)).status, 200); assert.equal(customWrites(t).length, 1);
    assert.equal(t.f.calls.some((call) => call.path === "/cf/admin/new_address"), false);
    assert.equal((await write(t, body("different123"), key)).body.error.code, "idempotency_conflict");
    assert.equal((await t.h.request(`/api/v1/mailboxes/${response.body.mailbox.id}/sync`, { method: "POST", cookie: t.alice.cookie, body: {} })).status, 200);
  } finally { await t.close(); }
});

test('invalid prefix and unknown capability stop before reservation, with no legacy-admin fallback', async () => {
  const t = await mailboxDeleteFixture();
  try {
    for (const prefix of ['', 'Upper', ' spaced ', 'a.b', 'a-b', '中文', 'x'.repeat(31), null, 123]) {
      const result = await write(t, body(prefix)); assert.equal(result.status, 400); assert.equal(result.body.error.code, 'invalid_mailbox_prefix');
    }
    assert.equal(t.f.calls.length, 0);
    t.f.modes.set('/cf/admin/custom_address_capability', 404);
    assert.equal((await write(t, body('chosen123'))).body.error.code, 'custom_prefix_unavailable');
    assert.equal((await t.h.db.prepare("SELECT cooldown_until FROM provider_allocation_state WHERE provider_id='self'").first()).cooldown_until, null,
      'An unsupported optional capability must not cool down working random allocation');
    assert.equal(t.f.calls.some((call) => call.path === '/cf/admin/new_address'), false);
    for (const mode of [{ enabled: true, minLength: 1, maxLength: 30, domains: ['cf.example.test'] },
      { contract: 'easyemail-custom-address-v1', enabled: true, minLength: 0, maxLength: 30, domains: ['cf.example.test'] }]) {
      t.f.modes.set('/cf/admin/custom_address_capability', mode);
      const result = await write(t, body('chosen123')); assert.equal(result.status, 502, result.text);
      assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations').first()).n, 0);
      await t.h.db.prepare('UPDATE provider_allocation_state SET cooldown_until=NULL,failure_count=0').run();
    }
    assert.equal(customWrites(t).length, 0); assert.equal(t.f.calls.some((call) => call.path === '/cf/admin/new_address'), false);
    const random = await write(t, { providerId: 'self', domain: 'cf.example.test' }); assert.equal(random.status, 201, random.text);
    assert.equal(t.f.calls.filter((call) => call.path === '/cf/admin/new_address').length, 1, 'Only an explicit random request may use legacy creation');
  } finally { await t.close(); }
});

test('a globally reserved custom address has one atomic winner across different owners and keys', async () => {
  const t = await mailboxDeleteFixture();
  try {
    const bob = await t.h.register(`custom-bob-${crypto.randomUUID()}`), gate = t.f.hold('/cf/admin/custom_address');
    const pending = write(t, body('sameaddress')); await gate.entered;
    let conflict;
    try { conflict = await write(t, body('sameaddress'), crypto.randomUUID(), bob.cookie); }
    finally { gate.release(); }
    assert.equal((await pending).status, 201); assert.equal(conflict.status, 409, conflict.text);
    assert.equal(conflict.body.error.code, 'mailbox_address_unavailable'); assert.doesNotMatch(conflict.text, new RegExp(t.alice.id));
    assert.equal(customWrites(t).length, 1);
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations').first()).n, 1);
    assert.equal((await t.h.db.prepare("SELECT allocation_count FROM provider_allocation_state WHERE provider_id='self'").first()).allocation_count, 1);
    const box = (await t.h.request('/api/v1/mailboxes', { cookie: t.alice.cookie })).body.items[0];
    await t.h.request(`/api/v1/mailboxes/${box.id}/lifecycle`, { method: 'POST', cookie: t.alice.cookie,
      body: { action: 'release', confirmAddress: box.address } });
    assert.equal((await write(t, body('sameaddress'), crypto.randomUUID(), bob.cookie)).status, 409);
    assert.equal(customWrites(t).length, 1, 'Released address guards remain reserved');
  } finally { await t.close(); }
});

test('unknown custom creation survives restart, keeps the exact address and never reissues the upstream write', async () => {
  const t = await mailboxDeleteFixture();
  try {
    t.f.modes.set('/cf/admin/custom_address', 'lose-response');
    const key = crypto.randomUUID(), response = await write(t, body('lostresult'), key);
    assert.equal(response.status, 202); assert.equal(response.body.creation.state, 'unknown');
    assert.equal(response.body.creation.address, 'lostresult@cf.example.test'); assert.equal(response.body.creation.retrySafe, false);
    assert.equal((await t.f.db.prepare("SELECT COUNT(*) n FROM address WHERE name='lostresult@cf.example.test'").first()).n, 1);
    const before = (await t.h.db.prepare('SELECT * FROM mailbox_creations').all()).results;
    await t.h.restart(); t.f.modes.clear(); const callCount = t.f.calls.length;
    const replay = await write(t, body('lostresult'), key); assert.equal(replay.status, 202);
    assert.equal(replay.body.creation.mailboxId, response.body.creation.mailboxId); assert.equal(t.f.calls.length, callCount);
    assert.deepEqual((await t.h.db.prepare('SELECT * FROM mailbox_creations').all()).results, before);
    assert.equal((await t.h.request(`/api/v1/mailbox-creations/${response.body.creation.mailboxId}`, { cookie: t.alice.cookie })).status, 200);
    assert.equal((await write(t, body('newresult'), key)).status, 409); assert.equal(customWrites(t).length, 1);
  } finally { await t.close(); }
});

test('automatic custom creation skips unsupported types and only fails over during bounded read-only capability checks', async () => {
  const t = await mailboxDeleteFixture();
  try {
    const base = JSON.parse(t.bindings.PROVIDER_CONFIG)[0];
    const config = [{ ...base, id: 'a-legacy', baseUrl: `${t.f.baseUrl}/legacy` }, { ...base, id: 'b-custom' },
      { id: 'a-temporam', type: 'temporam', baseUrl: `${t.f.baseUrl}/temporam`, domains: ['cf.example.test'] }];
    const secret = JSON.parse(t.bindings.PROVIDER_SECRETS).self;
    await t.h.restart({ PROVIDER_CONFIG: JSON.stringify(config), PROVIDER_SECRETS: JSON.stringify({ 'a-legacy': secret, 'b-custom': secret, 'a-temporam': secret }) });
    t.f.modes.set('/cf/legacy/admin/custom_address_capability', 404);
    const result = await write(t, { selection: 'automatic', prefix: 'autochosen' }); assert.equal(result.status, 201, result.text);
    assert.equal(result.body.mailbox.providerId, 'b-custom'); assert.equal(result.body.mailbox.address, 'autochosen@cf.example.test');
    assert.equal(customWrites(t).length, 1); assert.equal(t.f.calls.some((call) => call.path.includes('/temporam')), false);
    assert.equal(t.f.calls.filter((call) => call.method === 'POST').length, 1);
    t.f.modes.set('/cf/admin/custom_address', 'lose-response');
    const unknown = await write(t, { selection: 'automatic', prefix: 'autolost' }); assert.equal(unknown.status, 202);
    assert.equal(unknown.body.creation.providerId, 'b-custom'); assert.equal(customWrites(t).length, 2);
    assert.equal(t.f.calls.filter((call) => call.method === 'POST').length, 2, 'No write failover after reservation');
  } finally { await t.close(); }
});

test('manual custom preflight reports real limits and disabled policy never reserves a name', async () => {
  const t = await mailboxDeleteFixture(false, null, { customBindings: { MIN_ADDRESS_LEN: '5', MAX_ADDRESS_LEN: '9', DISABLE_CUSTOM_ADDRESS_NAME: 'true' } });
  try {
    const result = await t.h.request('/api/v1/providers/self/custom-prefix', { cookie: t.alice.cookie });
    assert.equal(result.status, 200); assert.deepEqual(result.body.customPrefix, { enabled: false, minLength: 5, maxLength: 9, domains: ['cf.example.test'] });
    const response = await write(t, body('chosen123')); assert.equal(response.status, 409); assert.equal(response.body.error.code, 'custom_prefix_unavailable');
    assert.equal((await t.h.db.prepare('SELECT COUNT(*) n FROM mailbox_creations').first()).n, 0); assert.equal(customWrites(t).length, 0);
  } finally { await t.close(); }
});

test('legacy random manual and automatic request hashes replay unchanged before any capability lookup', async () => {
  const t = await mailboxDeleteFixture();
  try {
    const entries = [
      { body: { providerId: 'self', domain: 'cf.example.test' }, serialized: JSON.stringify(['self', 'cf.example.test']) },
      { body: { selection: 'automatic' }, serialized: JSON.stringify({ selection: 'automatic', domain: null }) },
    ];
    for (const [index, entry] of entries.entries()) {
      Object.assign(entry, { key: crypto.randomUUID(), id: crypto.randomUUID(), address: `ee${String(index).repeat(32)}@cf.example.test` });
      await t.h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
        VALUES(?,?,?,?,?,'unknown',123)`).bind(t.alice.id, entry.key, createHash('sha256').update(entry.serialized).digest('hex'), entry.id, entry.address).run();
    }
    const before = (await t.h.db.prepare('SELECT * FROM mailbox_creations ORDER BY rowid').all()).results; await t.h.restart();
    for (const entry of entries) {
      const response = await write(t, entry.body, entry.key); assert.equal(response.status, 202);
      assert.equal(response.body.creation.address, entry.address);
      assert.equal((await write(t, { ...entry.body, prefix: 'newprefix' }, entry.key)).body.error.code, 'idempotency_conflict');
    }
    assert.equal(t.f.calls.length, 0); assert.deepEqual((await t.h.db.prepare('SELECT * FROM mailbox_creations ORDER BY rowid').all()).results, before);
  } finally { await t.close(); }
});
