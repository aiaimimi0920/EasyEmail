import assert from "node:assert/strict";
import { test } from "node:test";
import { agentInboundFixture } from "./agent-inbound-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";
import { newKey } from "./runtime-harness.mjs";

test("mixed-kind keyset pages merge two bounded branches without duplicates, preserve filters and never leak content to a metadata-only Key", async () => {
  const t = await agentInboundFixture();
  try {
    t.scenario({ uidNext: 23, messages: new Map(Array.from({ length: 22 }, (_, i) => [i + 1, agentReply(t.firstTask.messageId, { headers: "", subject: `分页来信-${i}` })])) });
    for (let i = 0; i < 7; i++) expect(await t.receive());
    let cursor = "", messages = [];
    do {
      const page = expect(await t.messages(cursor ? `?cursor=${encodeURIComponent(cursor)}` : "")); messages.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    assert.equal(messages.length, 22);
    const ids = [t.firstTask.id];
    for (const message of messages) {
      const receipt = expect(await t.h.request(`${t.base}/messages/${message.id}/inbound-thread`, { method: "PUT", cookie: t.alice.cookie,
        headers: { "idempotency-key": crypto.randomUUID() }, body: t.inputInbound() }), 201).operation;
      ids.push(receipt.threadId);
    }
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read"] }); cursor = ""; const rows = [];
    do {
      const page = expect(await t.threads(`?limit=7${cursor ? `&cursor=${cursor}` : ""}`, { token: key.token, origin: null }));
      assert.ok(page.items.length <= 7); rows.push(...page.items); cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(rows.map(row => row.id), ids.sort()); assert.equal(new Set(rows.map(row => row.id)).size, 23);
    const inbound = rows.filter(row => row.kind === "inbound"); assert.equal(inbound.length, 22);
    assert.ok(inbound.every(row => !Object.hasOwn(row, "task") && !Object.hasOwn(row.inbound, "subject") && !Object.hasOwn(row.inbound, "text")));
    expect(await t.message(messages[0].id, { token: key.token, origin: null }), 403);
    expect(await t.state(inbound[0].id, "completed")); expect(await t.state(inbound[1].id, "archived"));
    assert.deepEqual(expect(await t.threads("?state=completed")).items.map(row => row.id), [inbound[0].id]);
    assert.equal(expect(await t.threads("?state=needs_attention")).items.length, 20);
    assert.equal(expect(await t.threads("?state=open")).items.length, 1);
    expect(await t.threads(`?state=completed&cursor=${inbound[0].id}.archived`), 400);
  } finally { await t.close(); }
});
