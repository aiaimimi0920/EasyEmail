import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteFixture } from './remote-fixture.mjs';

const createFixture = (customBindings = {}) => remoteFixture({ fullSchema: true, legacyAuth: true, customBindings });
const headers = { 'content-type': 'application/json', 'x-admin-auth': 'synthetic-cf-admin' };
async function request(f, body, override = {}, endpoint = '/admin/custom_address') {
  const response = await fetch(`${f.baseUrl}${endpoint}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...headers, ...override }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  const text = await response.text(); return { status: response.status, body: JSON.parse(text), text, headers: response.headers };
}
const input = { name: 'chosen123', domain: 'cf.example.test' };
const count = async (f) => (await f.db.prepare('SELECT COUNT(*) n FROM address').first()).n;

test('custom endpoint uses real admin authentication even when legacy admin bypass or a role token is present', async () => {
  const f = await createFixture({ DISABLE_ADMIN_PASSWORD_CHECK: 'true' });
  try {
    for (const auth of ['', 'wrong']) for (const endpoint of ['/admin/custom_address', '/admin/custom_address_capability']) {
      const result = await request(f, endpoint.endsWith('capability') ? undefined : input,
        { 'x-admin-auth': auth, 'x-user-access-token': 'synthetic-role-token' }, endpoint);
      assert.equal(result.status, 401, result.text); assert.equal(result.body.error.code, 'custom_address_admin_required');
    }
    assert.equal(await count(f), 0);
    const capability = await request(f, undefined, {}, '/admin/custom_address_capability');
    assert.deepEqual(capability.body, { contract: 'easyemail-custom-address-v1', enabled: true, minLength: 1, maxLength: 30, domains: ['cf.example.test'] });
    assert.equal(capability.headers.get('cache-control'), 'no-store'); assert.equal(await count(f), 0);
    const result = await request(f, input); assert.equal(result.status, 201, result.text);
    assert.equal(result.body.address, 'chosen123@cf.example.test'); assert.ok(result.body.jwt); assert.ok(result.body.address_id > 0);
    assert.equal((await request(f, input)).status, 503, 'Duplicate must never issue an existing mailbox credential');
    assert.equal(await count(f), 1);
  } finally { await f.close(); }
});

test('custom endpoint rejects invalid names, transformed names, internal flags, invalid JSON and oversized actual streams before INSERT', async () => {
  const f = await createFixture({ PREFIX: 'system', ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH: 'true' });
  try {
    for (const name of ['', 'Upper', ' spaced ', 'a.b', 'a-b', 'name@other.test', '中文', 'a'.repeat(31)]) {
      assert.equal((await request(f, { ...input, name })).status, 400, name);
    }
    for (const extra of [{ enablePrefix: true }, { addressPrefix: 'bypass' }, { checkLengthByConfig: false },
      { enableCheckNameRegex: false }, { enableRandomSubdomain: true }, { checkAllowDomains: false }]) {
      assert.equal((await request(f, { ...input, ...extra })).status, 400);
    }
    for (const raw of ['{', '[]', 'null', '"text"']) assert.equal((await request(f, raw)).status, 400);
    assert.equal((await request(f, input, { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await request(f, `{"name":"${'x'.repeat(9000)}","domain":"cf.example.test"}`)).status, 413);
    const chunked = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"name":"${'x'.repeat(9000)}","domain":"cf.example.test"}`)); controller.close();
    } });
    const streamed = await fetch(`${f.baseUrl}/admin/custom_address`, { method: 'POST', headers, body: chunked, duplex: 'half' });
    assert.equal(streamed.status, 413); await streamed.body.cancel();
    for (const domain of ['sub.cf.example.test', 'other.test', 'CF.EXAMPLE.TEST', ' cf.example.test']) {
      assert.equal((await request(f, { ...input, domain })).status, 400);
    }
    assert.equal(await count(f), 0);
    const result = await request(f, input); assert.equal(result.status, 201, result.text);
    assert.equal(result.body.address, 'chosen123@cf.example.test', 'No configured prefix or random subdomain');
  } finally { await f.close(); }
});

test('strict policy keeps real length, regex, blacklist and default-domain restrictions; malformed storage fails closed', async () => {
  const f = await createFixture({ DOMAINS: '["cf.example.test","private.example.test"]', DEFAULT_DOMAINS: '["cf.example.test"]',
    MIN_ADDRESS_LEN: '5', MAX_ADDRESS_LEN: '9', ADDRESS_CHECK_REGEX: '^chosen[0-9]+$' });
  try {
    for (const name of ['abc', 'chosen12345', 'other123']) assert.equal((await request(f, { ...input, name })).status, 400);
    assert.equal((await request(f, { ...input, domain: 'private.example.test' })).status, 400);
    await f.db.prepare("INSERT INTO settings(key,value) VALUES('address_block_list','[\"chosen\"]')").run();
    assert.equal((await request(f, input)).status, 400);
    for (const raw of ['invalid', '{"x":1}', '[1]', 'null', '', '[""]']) {
      await f.db.prepare("UPDATE settings SET value=? WHERE key='address_block_list'").bind(raw).run();
      const result = await request(f, input); assert.equal(result.status, 503, raw);
      assert.equal(result.body.error.code, 'custom_address_policy_unavailable'); assert.doesNotMatch(result.text, /chosen|SELECT|settings|invalid/);
    }
    assert.equal(await count(f), 0);
    await f.db.prepare("UPDATE settings SET value='[]' WHERE key='address_block_list'").run();
    assert.equal((await request(f, input)).status, 201);
    await f.db.prepare('DROP TABLE settings').run();
    assert.equal((await request(f, { ...input, name: 'chosen456' })).status, 503);
    assert.equal(await count(f), 1);
  } finally { await f.close(); }
});

test('disabled and malformed environment policies cannot become an unrestricted admin create', async () => {
  for (const [bindings, status, code] of [
    [{ ADMIN_PASSWORDS: '[1]' }, 401, 'custom_address_admin_required'],
    [{ ENABLE_USER_CREATE_EMAIL: 'false' }, 403, 'custom_address_disabled'],
    [{ DISABLE_CUSTOM_ADDRESS_NAME: 'true' }, 403, 'custom_address_disabled'],
    [{ ADDRESS_CHECK_REGEX: '[' }, 503, 'custom_address_policy_unavailable'],
    [{ ADDRESS_REGEX: '[' }, 503, 'custom_address_policy_unavailable'],
    [{ MIN_ADDRESS_LEN: 'invalid' }, 503, 'custom_address_policy_unavailable'],
    [{ MIN_ADDRESS_LEN: '31', MAX_ADDRESS_LEN: '64' }, 503, 'custom_address_policy_unavailable'],
    [{ DOMAINS: '[1]' }, 503, 'custom_address_policy_unavailable'],
    [{ DOMAINS: '["*.example.test"]' }, 503, 'custom_address_policy_unavailable'],
    [{ DISABLE_CUSTOM_ADDRESS_NAME: 'invalid' }, 503, 'custom_address_policy_unavailable'],
    [{ ADDRESS_REGEX: '[0-9]' }, 400, 'invalid_custom_address_name'],
  ]) {
    const f = await createFixture(bindings);
    try {
      const result = await request(f, input); assert.equal(result.status, status, JSON.stringify(bindings));
      assert.equal(result.body.error.code, code); assert.equal(await count(f), 0);
    } finally { await f.close(); }
  }
});
