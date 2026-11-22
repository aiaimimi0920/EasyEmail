import assert from "node:assert/strict";
import { test } from "node:test";
import { agentWrite, agentDelete, agentAccountInput, expect } from "./agent-accounts-fixture.mjs";
import { agentSmtpFixture, agentSmtpInput as input, AGENT_SMTP_PASSWORD } from "./agent-smtp-fixture.mjs";

test("Agent SMTP config is private, independently encrypted and reconciled by immutable original-key receipts", async () => {
  const t = await agentSmtpFixture(), { h, alice, bob, id, route } = t;
  try {
    const empty = expect(await t.read()).smtp;
    assert.equal(empty.accountId, id); assert.equal(empty.scope, "agent"); assert.equal(empty.revision, 0); assert.equal(empty.credentialConfigured, false);
    assert.deepEqual(expect(await h.request("/api/v1/agent-accounts/smtp-endpoints", { cookie: alice.cookie })).items.map(row => [row.id, row.authentication]),
      [["smtp", "password"], ["starttls", "password"], ["google", "google-oauth2"]]);
    const key = crypto.randomUUID(), saved = expect(await t.configure(input, key));
    assert.equal(saved.operation.requestKey, key); assert.equal(saved.operation.accountId, id);
    assert.equal(saved.operation.accountRevision, 1); assert.equal(saved.operation.revision, 1); assert.equal(saved.operation.kind, "PUT");
    assert.equal(saved.smtp, undefined);
    const configured = expect(await t.read()).smtp;
    assert.equal(configured.current, true); assert.equal(configured.enabled, true); assert.equal(configured.credentialConfigured, true);
    const row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first();
    assert.ok(row.credential_cipher); assert.equal(JSON.stringify(row).includes(AGENT_SMTP_PASSWORD), false);
    assert.equal((await h.request(route, { cookie: bob.cookie })).status, 404);
    expect(await t.configure({ ...input, smtpRevision: 1, password: undefined, enabled: false }));
    const replay = expect(await t.configure(input, key)); assert.equal(replay.replayed, true); assert.deepEqual(replay.operation, saved.operation);
    assert.equal(expect(await t.read()).smtp.revision, 2); assert.equal(expect(await t.read()).smtp.enabled, false);
    assert.deepEqual(expect(await h.request(`/api/v1/agent-smtp-operations/${key}`, { cookie: alice.cookie })).operation, saved.operation);
    assert.equal((await h.request(`/api/v1/agent-smtp-operations/${key}`, { cookie: bob.cookie })).status, 404);
    expect(await t.configure({ ...input, password: "Different-synthetic-password" }, key), 409);
    await h.restart(); assert.deepEqual(expect(await t.configure(input, key)).operation, saved.operation);
    const privateReads = JSON.stringify([configured, saved, replay]); assert.equal(privateReads.includes(AGENT_SMTP_PASSWORD), false);
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM normal_smtp_configs").first("n"), 0);
    for (const table of ["outgoing_messages", "normal_outgoing_messages", "send_jobs", "normal_send_jobs"])
      assert.equal(await h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
  } finally { await t.close(); }
});

test("Agent SMTP identity and parent versions require explicit credential rebinding; account removal clears SMTP atomically", async () => {
  const t = await agentSmtpFixture(), { h, alice, id } = t;
  try {
    expect(await t.configure());
    expect(await t.configure({ ...input, smtpRevision: 1, username: "Changed", password: undefined }), 409);
    expect(await t.configure({ ...input, smtpRevision: 1, endpointId: "starttls", password: undefined }), 409);
    expect(await agentWrite(h, alice, id, { ...agentAccountInput, expectedRevision: 1, password: undefined, displayName: "New revision" }));
    assert.equal(expect(await t.read()).smtp.current, false);
    expect(await t.configure({ ...input, expectedRevision: 2, smtpRevision: 1, password: undefined }), 409);
    expect(await t.configure({ ...input, expectedRevision: 2, smtpRevision: 1 }));
    expect(await agentDelete(h, alice, id, 2));
    const row = await h.db.prepare("SELECT * FROM agent_smtp_configs WHERE account_id=?").bind(id).first();
    assert.equal(row.credential_cipher, null); assert.equal(row.enabled, 0); assert.equal(row.username, ""); assert.equal(row.revision, 3);
    expect(await t.read(), 404);
    expect(await t.configure({ ...input, expectedRevision: 3, smtpRevision: 3 }), 404);
  } finally { await t.close(); }
});
