import assert from "node:assert/strict";
import { test } from "node:test";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { putLabel, labelBody, expect, organize as temporaryOrganize } from "./labels-fixture.mjs";
import { putFolder, folderBody, deleteFolder } from "./folders-fixture.mjs";
import { newKey, seedMailbox } from "./runtime-harness.mjs";

const organize = (t, ids, patch, key = crypto.randomUUID(), extra = {}) => t.h.request(`${t.base}/messages/organize`, {
  method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body: { messageIds: ids, ...patch }, ...extra,
});
const taxonomy = (t, id, suffix, extra = {}) => t.h.request(`${t.base}/messages/${id}/${suffix}`, { cookie: t.alice.cookie, ...extra });
const timeline = (t, query, extra = {}) => t.h.request(`/api/v1/messages?sources=normal&${query}`, { cookie: t.alice.cookie, ...extra });

test("normal labels and one platform location reuse private resources, preserve old receipts and never mutate IMAP", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const ids = (await t.messages()).body.items.map(row => row.id), label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label, labelBody("普通工作")), 201);
    expect(await putFolder(t.h, t.alice, folder, folderBody("普通位置")), 201);
    const key = crypto.randomUUID(), patch = { addLabelIds: [label], folderId: folder, starred: true };
    expect(await organize(t, ids, patch, key));
    assert.equal(expect(await t.messages()).items.length, 0);
    assert.deepEqual(expect(await taxonomy(t, ids[0], "labels")).items.map(row => row.id), [label]);
    assert.equal(expect(await taxonomy(t, ids[0], "folder")).folder.id, folder);
    assert.equal(expect(await timeline(t, `labelId=${label}&folderId=${folder}`)).items.length, 2);
    expect(await organize(t, ids, { archived: true, removeLabelIds: [label] }));
    assert.equal(expect(await taxonomy(t, ids[0], "folder")).folder, null);
    assert.equal(expect(await timeline(t, "folder=archive")).items.length, 2);
    assert.equal(expect(await organize(t, [...ids].reverse(), patch, key)).replayed, true);
    assert.equal(expect(await taxonomy(t, ids[0], "labels")).items.length, 0);
    expect(await organize(t, ids, { folderId: folder, trashed: true, addLabelIds: [label] }));
    expect(await deleteFolder(t.h, t.alice, folder, 1)); expect(await deleteFolder(t.h, t.alice, folder, 1));
    assert.equal(expect(await taxonomy(t, ids[0], "folder")).folder, null);
    assert.equal(expect(await timeline(t, "folder=trash")).items.length, 2);
    expect(await organize(t, ids, { trashed: false })); assert.equal(expect(await t.messages()).items.length, 2);
    expect(await t.h.request(`/api/v1/labels/${label}`, { method: "DELETE", cookie: t.alice.cookie, body: { expectedRevision: 1 } }));
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_message_labels").first("n"), 0);
    assert.equal(expect(await organize(t, ids, patch, key)).replayed, true, "replay remains a receipt after target resources are deleted");
    assert.equal((await organize(t, ids, patch)).status, 409);
    await t.h.restart(); assert.equal(expect(await t.messages()).items.length, 2);
    assert.equal(t.opens.length, 1); assert.equal(t.calls.some(line => /STORE|EXPUNGE|COPY|MOVE/.test(line)), false);
  } finally { await t.close(); }
});

test("normal taxonomy validates complete targets, owner, read scopes and immutable original operation scopes", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const id = (await t.messages()).body.items[0].id, label = crypto.randomUUID(), folder = crypto.randomUUID();
    const bob = await t.h.register("normal-taxonomy-bob");
    expect(await putLabel(t.h, t.alice, label), 201); expect(await putFolder(t.h, t.alice, folder), 201);
    const foreign = crypto.randomUUID(); expect(await putLabel(t.h, bob, foreign), 201);
    assert.equal((await organize(t, [id], { isRead: true, addLabelIds: [label, foreign] })).status, 409);
    assert.equal((await t.message(id)).body.message.platformState.isRead, false);
    assert.equal((await organize(t, [id], { folderId: foreign })).status, 409);
    const basic = await newKey(t.h, t.alice.cookie, { scopes: ["mail-accounts:read", "messages:read", "messages:write"] });
    const limited = { token: basic.token, cookie: undefined, origin: null };
    assert.equal((await organize(t, [id], { addLabelIds: [label] }, undefined, limited)).status, 403);
    assert.equal((await organize(t, [id], { folderId: null }, undefined, limited)).status, 403);
    assert.equal((await taxonomy(t, id, "labels", limited)).status, 403);
    assert.equal((await taxonomy(t, id, "folder", limited)).status, 403);
    assert.equal((await timeline(t, `labelId=${label}`, limited)).status, 403);
    assert.equal((await timeline(t, `folderId=${folder}`, limited)).status, 403);
    assert.equal((await timeline(t, `labelId=${label}`, { cookie: bob.cookie })).status, 404);
    assert.equal((await t.messages(`?folderId=${folder}`, { cookie: bob.cookie })).status, 404);
    assert.equal((await taxonomy(t, id, "labels", { cookie: bob.cookie })).status, 404);
    assert.equal((await taxonomy(t, id, "folder?unexpected=1")).status, 400);
    const key = crypto.randomUUID(); expect(await organize(t, [id], { addLabelIds: [label], folderId: folder }, key));
    assert.equal((await t.h.request(`${t.base}/organization-operations/${key}`, limited)).status, 403);
    assert.equal((await organize(t, [id], { addLabelIds: [label], folderId: folder }, key, limited)).status, 403);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM normal_organization_operations").first("n"), 1);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});

test("shared taxonomy filters preserve colliding source identities, folder-bound cursors and temporary behavior", async () => {
  const t = await normalAccessFixture();
  try {
    await t.receive(); const ids = (await t.messages()).body.items.map(row => row.id), label = crypto.randomUUID(), folder = crypto.randomUUID();
    expect(await putLabel(t.h, t.alice, label), 201); expect(await putFolder(t.h, t.alice, folder), 201);
    const box = await seedMailbox(t.h, t.alice.id, "taxonomy@example.test");
    await t.h.db.prepare(`INSERT INTO messages(id,user_id,mailbox_id,remote_id,fingerprint,sender,recipient,subject,text_body,html_body,attachments,received_at,observed_at)
      VALUES (?,?,?,'collision','collision','','','taxonomy','','','[]',1,1)`).bind(ids[0], t.alice.id, box).run();
    expect(await temporaryOrganize(t.h, t.alice, { messageIds: [ids[0]], folderId: folder, addLabelIds: [label] }));
    expect(await organize(t, ids, { folderId: folder, addLabelIds: [label] }));
    const mixed = expect(await t.h.request(`/api/v1/messages?sources=all&labelId=${label}&folderId=${folder}`, { cookie: t.alice.cookie }));
    assert.equal(mixed.items.length, 3); assert.deepEqual(new Set(mixed.items.filter(row => row.id === ids[0]).map(row => row.sourceKind)), new Set(["normal", "temporary"]));
    const query = `?folder=inbox&folderId=${folder}&limit=1`, first = expect(await t.messages(query));
    assert.ok(first.nextCursor);
    assert.equal(expect(await t.messages(`${query}&cursor=${encodeURIComponent(first.nextCursor)}`)).items.length, 1);
    assert.equal((await t.messages(`?folder=inbox&cursor=${encodeURIComponent(first.nextCursor)}`)).status, 400);
    const page = expect(await timeline(t, `folderId=${folder}&labelId=${label}&limit=1`));
    assert.equal((await timeline(t, `folderId=${folder}&cursor=${encodeURIComponent(page.nextCursor)}`)).status, 400);
    expect(await organize(t, ids, { folderId: null, removeLabelIds: [label] }));
    assert.equal(expect(await t.messages()).items.length, 2);
    assert.equal(expect(await t.h.request(`/api/v1/messages?sources=all&labelId=${label}&folderId=${folder}`, { cookie: t.alice.cookie })).items.length, 1);
    assert.equal(await t.h.db.prepare("SELECT COUNT(*) n FROM message_labels WHERE label_id=?").bind(label).first("n"), 1);
    assert.equal(t.opens.length, 1);
  } finally { await t.close(); }
});
