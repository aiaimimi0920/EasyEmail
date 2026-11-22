import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { putLabel, expect } from "./labels-fixture.mjs";
import { putFolder, deleteFolder } from "./folders-fixture.mjs";

async function fixture() {
  const t = await normalAccessFixture({ testEntry: "./normal-organization-test-worker.ts" });
  await t.receive(); const label = crypto.randomUUID(), folder = crypto.randomUUID();
  expect(await putLabel(t.h, t.alice, label), 201); expect(await putFolder(t.h, t.alice, folder), 201);
  return { ...t, label, folder, ids: (await t.messages()).body.items.map(row => row.id) };
}
const organize = (t, key, mode = "", patch = { folderId: t.folder, addLabelIds: [t.label], starred: true }) => t.h.request(`${t.base}/messages/organize`, {
  method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key, "x-test-normal-organization": mode }, body: { messageIds: t.ids, ...patch },
});
async function empty(t) {
  for (const table of ["normal_message_state", "normal_message_labels", "normal_message_folders", "normal_organization_operations"]) {
    assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0, table);
  }
}

for (const change of ["label", "folder", "epoch"]) test(`normal taxonomy atomically fences a late ${change} change`, async () => {
  const t = await fixture(), gate = t.holdPut(); let pending;
  try {
    pending = organize(t, crypto.randomUUID(), "gate"); await gate.entered;
    if (change === "label") expect(await t.h.request(`/api/v1/labels/${t.label}`, { method: "DELETE", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
    if (change === "folder") expect(await deleteFolder(t.h, t.alice, t.folder, 1));
    if (change === "epoch") { t.scenario({ validity: "43" }); expect(await t.receive()); }
    gate.release(); const result = await pending; pending = null;
    assert.equal(result.status, 409, result.text); await empty(t);
  } finally { gate.release(); if (pending) await pending; await t.close(); }
});

test("normal taxonomy rollback, lost responses and same-key races cannot leave partial or resurrected associations", async () => {
  const t = await fixture();
  try {
    const key = crypto.randomUUID(); assert.equal((await organize(t, key, "rollback")).status, 503); await empty(t);
    assert.equal(expect(await organize(t, key, "lost")).replayed, true);
    for (const table of ["normal_message_labels", "normal_message_folders"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 2);
    expect(await organize(t, crypto.randomUUID(), "", { folderId: null, removeLabelIds: [t.label], starred: false }));
    const replay = await Promise.all([organize(t, key), organize(t, key)]); assert.ok(replay.every(row => row.status === 200 && row.body.replayed));
    for (const table of ["normal_message_labels", "normal_message_folders"]) assert.equal(await t.h.db.prepare(`SELECT COUNT(*) n FROM ${table}`).first("n"), 0);
    const racedKey = crypto.randomUUID(), raced = await Promise.all([organize(t, racedKey), organize(t, racedKey, "", { folderId: null, starred: false })]);
    assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]);
    const applied = raced[0].status === 200;
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_folders").first("n"), applied ? 2 : 0);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_labels").first("n"), applied ? 2 : 0);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
