import assert from "node:assert/strict";
import { test } from "node:test";
import { normalSendFixture, mailInput } from "./normal-send-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

test("ordinary drafts require separate permissions, exact origin, account ownership and supported intent", async () => {
  const t = await normalSendFixture();
  try {
    await t.configure(); const id = crypto.randomUUID(), path = `${t.path}/drafts/${id}`;
    const body = { expectedRevision: 0, accountRevision: 1, to: mailInput.to, subject: mailInput.subject, text: mailInput.text };
    const write = extra => t.h.request(path, { cookie: t.alice.cookie, method: "PUT", body, ...extra });
    const bob = await t.h.register("draft-boundary-bob"); assert.equal((await write({ cookie: bob.cookie })).status, 404);
    assert.equal((await write({ origin: "https://foreign.example.test" })).status, 403);
    for (const scopes of [["drafts:write"], ["mail-accounts:read"], ["mail-accounts:read", "mail-accounts:send"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes }); assert.equal((await write({ cookie: null, token: key.token, origin: null })).status, 403);
    }
    for (const extra of [{ accountRevision: 0 }, { accountRevision: 2 }, { mailboxId: null }, { normalAccountId: t.id },
      { attachments: "invalid" }, { scheduledAt: null }, { subject: "\ud800", text: "\udc00" }]) {
      const result = await write({ body: { ...body, ...extra } }); assert.ok([400, 409].includes(result.status), result.text);
    }
    const writer = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "drafts:read", "drafts:write"] });
    assert.equal((await write({ cookie: null, token: writer.token, origin: null })).status, 201);
    const input = { ...mailInput, draftId: id, draftRevision: 1 };
    assert.equal((await t.send(input, crypto.randomUUID(), { cookie: null, token: writer.token })).status, 403);
    const sender = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:send"] });
    assert.equal((await t.send(input, crypto.randomUUID(), { cookie: null, token: sender.token })).status, 403);
    const both = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:send", "drafts:write"] });
    assert.equal((await t.send(input, crypto.randomUUID(), { cookie: null, token: both.token, origin: null })).status, 201);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("draft identity and cursors cannot cross temporary/account boundaries; shared limit and tombstones survive", async () => {
  const t = await normalSendFixture();
  try {
    const id = crypto.randomUUID(), route = `${t.path}/drafts/${id}`, box = await seedMailbox(t.h, t.alice.id, "temp@example.test");
    const body = { expectedRevision: 0, accountRevision: 1, to: "", subject: "", text: "" };
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body })).status, 201);
    const second = crypto.randomUUID(), secondPath = `/api/v1/normal-accounts/${second}`;
    assert.equal((await t.h.request(secondPath, { cookie: t.alice.cookie, method: "PUT", headers: { "idempotency-key": crypto.randomUUID() },
      body: { expectedRevision: 0, emailAddress: "second@example.test", displayName: "Second", endpointId: "example", username: "Second", password: "Synthetic-second-password", enabled: false } })).status, 201);
    for (const method of ["GET", "PUT", "DELETE"]) assert.equal((await t.h.request(`${secondPath}/drafts/${id}`, {
      cookie: t.alice.cookie, method, body: method === "GET" ? undefined : method === "PUT" ? body : { expectedRevision: 1 },
    })).status, 404);
    assert.equal((await t.h.request(`${secondPath}/drafts?cursor=${id}`, { cookie: t.alice.cookie })).status, 400);
    for (const method of ["GET", "DELETE", "PUT"]) {
      const result = await t.h.request(`/api/v1/drafts/${id}`, { cookie: t.alice.cookie, method,
        body: method === "GET" ? undefined : method === "DELETE" ? { expectedRevision: 1 } : { expectedRevision: 1, mailboxId: box, to: "", subject: "", text: "" } });
      assert.equal(result.status, 404, result.text);
    }
    assert.equal((await t.h.request(`/api/v1/drafts?cursor=${id}`, { cookie: t.alice.cookie })).status, 400);
    const temporary = crypto.randomUUID();
    assert.equal((await t.h.request(`/api/v1/drafts/${temporary}`, { cookie: t.alice.cookie, method: "PUT", body: { expectedRevision: 0, mailboxId: box, to: "", subject: "", text: "" } })).status, 201);
    assert.equal((await t.h.request(`${t.path}/drafts?cursor=${temporary}`, { cookie: t.alice.cookie })).status, 400);
    for (const query of ["limit=1&limit=2", "source=normal", "cursor=not-uuid"]) assert.equal((await t.h.request(`${t.path}/drafts?${query}`, { cookie: t.alice.cookie })).status, 400);
    assert.equal((await t.h.request(`${t.path}/drafts/${temporary}`, { cookie: t.alice.cookie, method: "PUT", body })).status, 404);
    await t.h.db.prepare("UPDATE normal_accounts SET enabled=0 WHERE id=?").bind(t.id).run();
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body: { ...body, expectedRevision: 1, text: "offline draft" } })).status, 200);
    await t.h.db.prepare("UPDATE normal_accounts SET deleted_at=1 WHERE id=?").bind(t.id).run();
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie })).status, 200);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body: { ...body, expectedRevision: 2 } })).status, 404);
    const removed = await t.h.request(route, { cookie: t.alice.cookie, method: "DELETE", body: { expectedRevision: 2 } }); assert.equal(removed.status, 200);
    const row = await t.h.db.prepare("SELECT * FROM drafts WHERE id=?").bind(id).first(); assert.equal(row.text_body, ""); assert.equal(row.normal_account_id, t.id);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "DELETE", body: { expectedRevision: 2 } })).status, 200);
    assert.equal((await t.h.request(route, { cookie: t.alice.cookie, method: "PUT", body: { ...body, expectedRevision: 3 } })).status, 409);
  } finally { await t.close(); }
});

test("ordinary and temporary draft writers share one atomic content limit while tombstones free a slot", async () => {
  const t = await normalSendFixture();
  try {
    await t.h.db.batch(Array.from({ length: 99 }, () => t.h.db.prepare("INSERT INTO drafts(user_id,id,revision,content_hash,created_at,updated_at) VALUES (?,?,1,'seed',1,1)")
      .bind(t.alice.id, crypto.randomUUID())));
    const ids = [crypto.randomUUID(), crypto.randomUUID()], ordinary = `${t.path}/drafts/${ids[0]}`, temporary = `/api/v1/drafts/${ids[1]}`;
    const fields = { expectedRevision: 0, to: "", subject: "", text: "" };
    const results = await Promise.all([t.h.request(ordinary, { cookie: t.alice.cookie, method: "PUT", body: { ...fields, accountRevision: 1 } }),
      t.h.request(temporary, { cookie: t.alice.cookie, method: "PUT", body: fields })]);
    assert.deepEqual(results.map(row => row.status).sort(), [201, 409]);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM drafts WHERE state!='deleted'").first("n"), 100);
    const winner = results[0].status === 201 ? ordinary : temporary;
    assert.equal((await t.h.request(winner, { cookie: t.alice.cookie, method: "DELETE", body: { expectedRevision: 1 } })).status, 200);
    assert.equal((await t.h.request(`${t.path}/drafts/${crypto.randomUUID()}`, { cookie: t.alice.cookie, method: "PUT", body: { ...fields, accountRevision: 1 } })).status, 201);
  } finally { await t.close(); }
});
