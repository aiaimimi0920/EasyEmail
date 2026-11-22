import assert from "node:assert/strict";
import { test } from "node:test";
import { newKey } from "./runtime-harness.mjs";
import { agentThreadsFixture } from "./agent-threads-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

test("thread lifecycle separates read/write/send scopes, origins and owners without extending old Keys", async () => {
  const t = await agentThreadsFixture();
  try {
    const task = await t.task(), bob = await t.h.register("thread-boundaries-bob");
    for (const scopes of [["agent-tasks:read"], ["agent-tasks:read", "agent-tasks:send"], ["agent-inbox:review"], ["agent-threads:write"]]) {
      const key = await newKey(t.h, t.alice.cookie, { scopes });
      expect(await t.state(task.id, "archived", 0, undefined, { token: key.token, origin: null }), 403);
    }
    const key = await newKey(t.h, t.alice.cookie, { scopes: ["agent-tasks:read", "agent-threads:write"] });
    const options = { token: key.token, origin: null };
    expect(await t.state(task.id, "completed", 0, undefined, { origin: null }), 403);
    expect(await t.state(task.id, "completed", 0, undefined, { origin: "https://evil.example.test" }), 403);
    expect(await t.thread(task.id, { cookie: bob.cookie }), 404); expect(await t.state(task.id, "archived", 0, undefined, { cookie: bob.cookie }), 404);
    const receipt = expect(await t.state(task.id, "completed", 0, undefined, options)).operation;
    expect(await t.operation(receipt.requestKey, { cookie: bob.cookie }), 404);
    assert.equal(expect(await t.threads("", { cookie: bob.cookie })).items.length, 0);
    expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", token: key.token, body: {} }), 403);
    expect(await t.h.request(`${t.base}/sync`, { method: "POST", token: key.token, body: {} }), 403);
    assert.equal(t.opens.length, 0);
  } finally { await t.close(); }
});

test("thread state input and bound pagination reject partial, ambiguous, unsafe and cross-filter requests", async () => {
  const t = await agentThreadsFixture();
  try {
    const a = await t.task(), b = await t.task(), c = await t.task();
    for (const body of [{}, { state: "archived" }, { expectedRevision: 0 }, { expectedRevision: -1, state: "open" },
      { expectedRevision: 0.1, state: "open" }, { expectedRevision: Number.MAX_SAFE_INTEGER, state: "open" },
      { expectedRevision: "0", state: "open" }, { expectedRevision: 0, state: "awaiting_reply" },
      { expectedRevision: 0, state: "open", send: true }, { expectedRevision: 0, state: null }]) {
      expect(await t.state(a.id, "open", 0, undefined, { body }), 400);
    }
    expect(await t.state(a.id, "open", 0, "bad-key"), 400);
    for (const q of ["?state=", "?state=open&state=open", "?limit=21", "?limit=0", "?limit=x", "?unknown=1", "?cursor=bad"]) expect(await t.threads(q), 400);
    const first = expect(await t.threads("?state=open&limit=1")); assert.equal(first.items.length, 1); assert.ok(first.nextCursor);
    assert.equal(Object.hasOwn(first.items[0].task, "text"), false);
    expect(await t.threads(`?state=archived&cursor=${first.nextCursor}`), 400); expect(await t.threads(`?cursor=${first.nextCursor}`), 400);
    const second = expect(await t.threads(`?state=open&limit=2&cursor=${first.nextCursor}`));
    assert.deepEqual([...first.items, ...second.items].map(row => row.id).sort(), [a.id, b.id, c.id].sort()); assert.equal(second.nextCursor, null);
    expect(await t.thread(a.id, { method: "DELETE" }), 405); expect(await t.thread(`${a.id}?state=open`), 400);
  } finally { await t.close(); }
});
