import assert from 'node:assert/strict';
import { test } from 'node:test';
import { adminFixture } from './admin-fixture.mjs';
import { newKey, seedMailbox, PASSWORD } from './runtime-harness.mjs';

test('admin disabling and re-enabling a user preserves resources but never revives old sessions or API keys', async () => {
  const a = await adminFixture(), { h, admin, alice } = a;
  try {
    const key = await newKey(h, alice.cookie);
    const mailboxId = await seedMailbox(h, alice.id, 'account-retained@example.test');
    const preserved = await h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(mailboxId).first();
    const list = await h.request('/api/v1/admin/users', { cookie: admin.cookie }); assert.equal(list.status, 200, list.text);
    const target = list.body.items.find((row) => row.id === alice.id); assert.equal(target.status, 'active');
    const disabled = await h.request(`/api/v1/admin/users/${alice.id}/status`, { method: 'POST', cookie: admin.cookie,
      body: { status: 'disabled', expectedRevision: target.revision, confirmUsername: alice.username } });
    assert.equal(disabled.status, 200, disabled.text); assert.equal(disabled.body.user.status, 'disabled');
    assert.equal((await h.request('/api/v1/me', { cookie: alice.cookie })).status, 401);
    assert.equal((await h.request('/api/v1/me', { token: key.token })).status, 401);
    assert.equal((await h.request('/api/v1/auth/login', { method: 'POST', body: { username: alice.username, password: PASSWORD } })).status, 401);
    await h.restart();
    const enabled = await h.request(`/api/v1/admin/users/${alice.id}/status`, { method: 'POST', cookie: admin.cookie,
      body: { status: 'active', expectedRevision: disabled.body.user.revision, confirmUsername: alice.username } });
    assert.equal(enabled.status, 200, enabled.text);
    assert.equal((await h.request('/api/v1/me', { cookie: alice.cookie })).status, 401);
    assert.equal((await h.request('/api/v1/me', { token: key.token })).status, 401);
    const fresh = await h.request('/api/v1/auth/login', { method: 'POST', body: { username: alice.username, password: PASSWORD } });
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal((await h.request(`/api/v1/mailboxes/${mailboxId}`, { cookie: fresh.cookie })).status, 200);
    assert.deepEqual(await h.db.prepare('SELECT * FROM mailboxes WHERE id=?').bind(mailboxId).first(), preserved);
    const audit = await h.request(`/api/v1/admin/users/audit?userId=${alice.id}&limit=1`, { cookie: admin.cookie });
    const next = await h.request(`/api/v1/admin/users/audit?userId=${alice.id}&limit=1&cursor=${audit.body.nextCursor}`, { cookie: admin.cookie });
    assert.deepEqual([...audit.body.items, ...next.body.items].map((row) => row.action).sort(), ['disable', 'enable']);
  } finally { await a.close(); }
});
