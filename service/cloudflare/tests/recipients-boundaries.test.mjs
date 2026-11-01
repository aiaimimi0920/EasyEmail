import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createHarness, newKey } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendBody, sendCalls, sendRequest } from "./send-fixture.mjs";
import { saveDraft, draftBody } from "./draft-fixture.mjs";

let f, h, alice, box;
before(async () => {
  f = await sendFixture("binding", ["allowed@example.test", "copy@example.test"]); h = await createHarness(f.bindings);
  alice = await h.register("recipients-boundary"); box = (await allocate(h, alice.cookie)).body.mailbox;
});
beforeEach(async () => { await h.resetLimits(); await h.db.prepare("DELETE FROM outgoing_messages").run(); });
after(async () => { try { await h?.close(); } finally { await f?.close(); } });

test("every To/CC/BCC address requires allowlist approval and send scope before reservation", async () => {
  const count = sendCalls(f).length;
  for (const fields of [{ cc: ["denied@example.test"] }, { bcc: ["denied@example.test"] }, { to: ["allowed@example.test", "denied@example.test"] }]) {
    const result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test", ...fields });
    assert.equal(result.status, 403, result.text); assert.equal(result.body.error.code, "recipient_not_allowed");
  }
  const reader = await newKey(h, alice.cookie, { scopes: ["messages:read"] });
  assert.equal((await sendRequest(h, null, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test", cc: ["copy@example.test"] }, { token: reader.token, origin: null })).status, 403);
  assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0); assert.equal(sendCalls(f).length, count);
});

test("strict bounded recipient inputs refuse injection, named mailboxes, nested/empty arrays and oversized bodies", async () => {
  const count = sendCalls(f).length;
  const invalid = [{ to: [] }, { to: [""] }, { to: [null] }, { to: [["allowed@example.test"]] }, { cc: null }, { cc: "copy@example.test" },
    { cc: ["A <copy@example.test>"] }, { bcc: ["victim@example.test\r\nTo: leak@example.test"] },
    { bcc: ["a@example.test,b@example.test"] }, { bcc: [{}] }, { to: Array(51).fill("allowed@example.test") },
    { to: Array(49).fill("allowed@example.test"), cc: ["copy@example.test"], bcc: ["copy@example.test"] }];
  for (const fields of invalid) {
    const body = { ...sendBody, to: "allowed@example.test", ...fields };
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), body)).status, 400, JSON.stringify(fields));
    assert.equal((await saveDraft(h, alice.cookie, crypto.randomUUID(), draftBody(box.id, body))).status, 400, JSON.stringify(fields));
  }
  const fifty = { ...sendBody, to: "allowed@example.test", cc: Array(49).fill("copy@example.test") };
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), fifty)).status, 201, "Raw 50 accepted, duplicate targets count once");
  const huge = { ...sendBody, to: "allowed@example.test", text: "文".repeat(3000) };
  assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), huge)).status, 413);
  assert.equal(sendCalls(f).length, count + 1);
});

test("worker transport refuses multi-recipient content before reservations; singleton empty lists remain compatible", async () => {
  const config = JSON.parse(f.bindings.PROVIDER_CONFIG); config[0].sendTransport = "worker";
  await h.restart({ PROVIDER_CONFIG: JSON.stringify(config) });
  try {
    const count = sendCalls(f).length;
    for (const fields of [{ to: ["allowed@example.test", "copy@example.test"] }, { cc: ["copy@example.test"] }, { bcc: ["copy@example.test"] }]) {
      const result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test", ...fields });
      assert.equal(result.body.error.code, "multiple_recipients_unavailable", result.text);
    }
    assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
    assert.equal(sendCalls(f).length, count);
    assert.equal((await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to: ["allowed@example.test"], cc: [], bcc: [] })).status, 201);
    assert.equal(sendCalls(f).at(-1).body.to_mail, "allowed@example.test");
  } finally { await h.restart({ PROVIDER_CONFIG: f.bindings.PROVIDER_CONFIG }); }
});

test("recipient weight also enforces user UTC-day and platform minute/day budgets, including redacted guards", async () => {
  const other = await h.register("recipient-budget-other"), otherBox = (await allocate(h, other.cookie)).body.mailbox;
  const sent = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test" });
  assert.equal(sent.status, 201, sent.text);
  const row = await h.db.prepare("SELECT * FROM outgoing_messages WHERE id=?").bind(sent.body.outgoing.id).first();
  const columns = Object.keys(row), now = Math.floor(Date.now() / 1000), day = Math.floor(now / 86400) * 86400;
  for (const limit of [{ count: 1, weight: 20, own: true, at: day }, { count: 1, weight: 10, own: false, at: now },
    { count: 4, weight: 50, own: false, at: day }]) {
    await h.db.prepare("DELETE FROM outgoing_messages").run();
    for (let i = 0; i < limit.count; i++) {
      const copy = { ...row, id: crypto.randomUUID(), request_key: crypto.randomUUID(), recipient_count: limit.weight,
        user_id: limit.own ? alice.id : other.id, mailbox_id: limit.own ? box.id : otherBox.id,
        created_at: limit.at, content_purged_at: now, from_address: "", to_address: "", state: "unknown" };
      await h.db.prepare(`INSERT INTO outgoing_messages (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`)
        .bind(...columns.map(column => copy[column])).run();
    }
    const count = sendCalls(f).length, result = await sendRequest(h, alice.cookie, box, crypto.randomUUID(), { ...sendBody, to: "allowed@example.test" });
    assert.equal(result.body.error.code, "send_quota_exceeded", JSON.stringify(limit)); assert.equal(sendCalls(f).length, count);
  }
});
