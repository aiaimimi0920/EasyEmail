import assert from "node:assert/strict";
import { test } from "node:test";
import { agentFollowupsFixture } from "./agent-followups-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("follow-up pages are bounded, ordered, same-root cursors and omit body/address fields", async () => {
  const t = await agentFollowupsFixture();
  try {
    const task = expect(await t.enqueue(), 201).task; await t.run(); const input = await t.followupInput(task.id), ids = [];
    for (let i = 0; i < 23; i++) ids.push(expect(await t.followup(task.id, input), 201).followup.id);
    const first = expect(await t.followupList(task.id)); assert.equal(first.items.length, 20); assert.equal(first.nextCursor, first.items.at(-1).id);
    const next = expect(await t.followupList(task.id, `?cursor=${first.nextCursor}`)); assert.equal(next.items.length, 3); assert.equal(next.nextCursor, null);
    assert.deepEqual([...first.items, ...next.items].map(row => row.id), ids.sort());
    for (const row of first.items) for (const field of ["text", "from", "to"]) assert.equal(Object.hasOwn(row, field), false);
    const other = expect(await t.enqueue(), 201).task;
    expect(await t.followupList(other.id, `?cursor=${ids[0]}`), 400);
    for (const query of ["?limit=21", "?limit=0", "?limit=2&limit=2", "?cursor=bad", "?filter=queued"]) expect(await t.followupList(task.id, query), 400);
  } finally { await t.close(); }
});
