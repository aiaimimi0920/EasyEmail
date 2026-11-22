import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

let m;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mixed-")), outfile = path.join(directory, "plan.mjs");
  await build({ stdin: { contents: 'export * from "./mixed-organization-plan"; export * from "./mixed-organization-execution"; export { ApiError } from "./api";',
    resolveDir: fileURLToPath(new URL("../web/", import.meta.url)), loader: "ts" }, outfile, bundle: true, format: "esm", platform: "neutral" });
  m = await import(pathToFileURL(outfile));
});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const targets = () => [{ id: id(1) }, { id: id(1), sourceKind: "normal", accountId: id(10) }, { id: id(1), sourceKind: "normal", accountId: id(20) }];
const plan = () => m.createOrganizationPlan(targets(), { isRead: true });
const receipt = group => ({ operation: { id: id(50), key: group.key, messageCount: group.body.messageIds.length, completedAt: 1,
  ...(group.accountId ? { accountId: group.accountId, serverFolderId: group.serverFolderId, accountRevision: 1, epochId: id(60), upstreamChanged: false } : {}) }, replayed: false });

test("mixed selection qualifies equal UUIDs by source/account and freezes one distinct key per deterministic group", () => {
  const rows = targets(), groups = m.createOrganizationPlan(rows.reverse(), { isRead: true });
  assert.equal(new Set(rows.map(m.messageSelectionKey)).size, 3);
  assert.deepEqual(groups.map(group => group.accountId), [null, id(10), id(20)]);
  assert.equal(new Set(groups.map(group => group.key)).size, 3); assert.ok(groups.every(group => group.body.messageIds.length === 1));
  assert.equal(m.groupReceiptPath(groups[0]), `/organization/${groups[0].key}`);
  assert.equal(m.groupWritePath(groups[1]), `/normal-accounts/${id(10)}/messages/organize`);
});
test("overall selection is bounded to 50 and rejects duplicate, unsupported or unqualified identities before dispatch", () => {
  for (const rows of [[], Array.from({ length: 51 }, (_, n) => ({ id: id(n) })), [{ id: id(1) }, { id: id(1) }],
    [{ id: id(1), sourceKind: "normal" }], [{ id: "bad" }], [{ id: id(1), sourceKind: "other" }]]) {
    assert.throws(() => m.createOrganizationPlan(rows, { starred: true }));
  }
  assert.equal(m.createOrganizationPlan(Array.from({ length: 50 }, (_, n) => ({ id: id(n) })), { starred: true })[0].body.messageIds.length, 50);
});
test("server folder groups carry separate immutable paths and malformed identity rejects the whole plan before allocating keys", () => {
  const inbox = targets()[1], folder = { ...inbox, serverFolderId: "a".repeat(64) }; let keys = 0;
  assert.notEqual(m.messageSelectionKey(inbox), m.messageSelectionKey(folder));
  assert.equal(m.canOrganizeMessage(folder), true); assert.equal(m.canOrganizeMessage(inbox), true);
  const groups = m.createOrganizationPlan([targets()[0], inbox, folder], { isRead: true });
  assert.equal(groups.length, 3); const directory = groups.find(row => row.serverFolderId);
  assert.equal(m.groupWritePath(directory), `/normal-accounts/${inbox.accountId}/server-folders/${folder.serverFolderId}/messages/organize`);
  assert.match(m.groupReceiptPath(directory), new RegExp(`/server-folders/${folder.serverFolderId}/organization-operations/`));
  folder.serverFolderId = "b".repeat(64); assert.equal(directory.serverFolderId, "a".repeat(64));
  assert.throws(() => m.createOrganizationPlan([targets()[0], inbox, { ...folder, serverFolderId: "bad" }], { isRead: true }, () => { keys++; return crypto.randomUUID(); }), /服务器文件夹/);
  assert.equal(keys, 0);
});
test("later caller edits cannot change held identities, label arrays, targets or patch", () => {
  const rows = targets(), patch = { addLabelIds: [id(30)], removeLabelIds: [id(40)], folderId: id(60) }, groups = m.createOrganizationPlan(rows, patch);
  patch.addLabelIds[0] = id(31); patch.removeLabelIds.push(id(41)); patch.folderId = null; rows[1].accountId = id(99); rows[0].id = id(98);
  assert.deepEqual(groups[0].body.addLabelIds, [id(30)]); assert.deepEqual(groups[0].body.removeLabelIds, [id(40)]);
  assert.equal(groups[0].body.folderId, id(60)); assert.equal(groups[1].accountId, id(10)); assert.deepEqual(groups[0].body.messageIds, [id(1)]);
  assert.ok(Object.isFrozen(groups[0].body)); assert.ok(Object.isFrozen(groups[0].body.addLabelIds)); assert.ok(Object.isFrozen(groups[0].body.messageIds));
});
test("sequential dispatch stops after an unknown group, preserving completed and never-executed groups", async () => {
  const groups = plan(), calls = [], updates = [];
  const next = await m.executeReadyGroups(groups, rows => updates.push(rows.map(row => row.state)), () => true, async path => {
    calls.push(path); if (calls.length === 2) throw new TypeError("response lost"); return receipt(groups[0]);
  });
  assert.equal(calls.length, 2); assert.deepEqual(next.map(row => row.state), ["completed", "unknown", "ready"]);
  assert.equal(m.unfinishedGroups(next), true); assert.deepEqual(updates.at(-1), ["completed", "unknown", "ready"]);
});
test("404 reconciliation and denied retry cannot turn a previously unknown commit into a definite rejection", async () => {
  const group = { ...plan()[1], state: "unknown" }, calls = [];
  for (const [readOnly, status] of [[true, 404], [false, 403], [false, 409], [false, 429]]) {
    const next = await m.executeOrganizationGroup(group, readOnly, async (...args) => { calls.push(args); throw new m.ApiError(status, "synthetic_denied"); });
    assert.equal(next.state, "unknown"); assert.equal(next.key, group.key); assert.deepEqual(next.body, group.body);
  }
  assert.equal(calls[0][0], m.groupReceiptPath(group)); assert.equal(calls[0][1], undefined);
  assert.equal((await m.executeOrganizationGroup(plan()[1], false, async () => { throw new m.ApiError(409, "target_changed"); })).state, "rejected");
});
test("original-key retry only replays its receipt and does not override a later state", async () => {
  const group = plan()[0], committed = new Map(); let state = false, lose = true;
  const request = async (_path, _method, body, headers) => {
    if (!committed.has(headers["idempotency-key"])) { state = body.isRead; committed.set(headers["idempotency-key"], receipt(group)); }
    if (lose) { lose = false; throw new TypeError("response lost"); } return committed.get(headers["idempotency-key"]);
  };
  const unknown = await m.executeOrganizationGroup(group, false, request); assert.equal(state, true); state = false;
  const replay = await m.executeOrganizationGroup(unknown, false, request); assert.equal(replay.state, "completed"); assert.equal(state, false); assert.equal(committed.size, 1);
});
test("mismatched receipts remain unknown and read-only reconciliation never emits a POST", async () => {
  const group = { ...plan()[1], state: "unknown" }, calls = [];
  for (const value of [{ operation: { key: "wrong", messageCount: 1 } }, { operation: { key: group.key, messageCount: 99 } }, {}]) {
    assert.equal((await m.executeOrganizationGroup(group, true, async (...args) => { calls.push(args); return value; })).state, "unknown");
  }
  assert.ok(calls.every(args => args.length === 1));
  assert.equal((await m.executeOrganizationGroup(group, true, async () => receipt(group))).state, "completed");
});
test("directory receipt must match its persistent account and directory before an uncertain key is released", async () => {
  const group = m.createOrganizationPlan([{ ...targets()[1], serverFolderId: "a".repeat(64) }], { isRead: true })[0];
  for (const patch of [{ accountId: id(99) }, { serverFolderId: undefined }, { upstreamChanged: true }, { completedAt: null }]) {
    assert.equal((await m.executeOrganizationGroup(group, true, async () => ({ ...receipt(group), operation: { ...receipt(group).operation, ...patch } }))).state, "unknown");
  }
});
test("logout or provider disposal stops before dispatching any later account", async () => {
  const groups = plan(); let active = true, calls = 0;
  const next = await m.executeReadyGroups(groups, () => {}, () => active, async () => { calls++; active = false; return receipt(groups[0]); });
  assert.equal(calls, 1); assert.deepEqual(next.map(row => row.state), ["completed", "ready", "ready"]);
});
