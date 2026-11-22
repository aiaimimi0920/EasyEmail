import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";
import { mailboxData } from "./normal-folder-inbox-fixture.mjs";

test("owned directory move persists exact phases and mapping, preserves receive facts and permanently replays its key", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID();
  try {
    const before = await t.sourceRows(), response = await t.mutate(key);
    assert.equal(response.status, 201, response.text); const operation = response.body.operation;
    assert.equal(operation.state, "confirmed"); assert.equal(operation.phase, "move"); assert.equal(operation.sourceRemoved, true);
    assert.equal(operation.serverFolderId, t.folder(t.source).id); assert.equal(operation.destinationFolderId, t.folder(t.destination).id);
    assert.deepEqual(operation.destination, { uidValidity: "42", uid: 501 }); assert.equal(operation.retrySafe, false); assert.equal(operation.cacheRetained, true);
    assert.deepEqual(await t.sourceRows(), before);
    const opens = t.opens.length;
    assert.deepEqual((await t.mutate(key)).body.operation, operation); assert.deepEqual((await t.operation(key)).body.operation, operation);
    assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1);
    assert.equal((await t.flag()).status, 409); assert.equal((await t.mutate()).status, 409); assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});

for (const options of [{ source: "INBOX" }, { destination: "INBOX" }, { capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" }]) {
  test(`explicit move supports canonical INBOX and exact fallback without rebasing caches: ${JSON.stringify(options)}`, async () => {
    const t = await mutationOperationFixture(options);
    try {
      const before = await t.sourceRows(), result = await t.mutate();
      assert.equal(result.status, 201, result.text); assert.equal(result.body.operation.state, "confirmed");
      assert.equal(result.body.operation.method, options.capabilities ? "copy-expunge" : "move");
      assert.equal(result.body.operation.phase, options.capabilities ? "expunge" : "move");
      assert.deepEqual(await t.sourceRows(), before);
      const writes = t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line));
      assert.equal(writes.length, options.capabilities ? 3 : 1);
      assert.equal(writes.some(line => /(?:^| )CLOSE|^\S+ EXPUNGE$/.test(line)), false);
    } finally { await t.close(); }
  });
}
test("permanent delete expunges only the exact source UID and retains cached content", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID();
  try {
    const before = await t.sourceRows(), result = await t.remove(key);
    assert.equal(result.status, 201, result.text); assert.equal(result.body.operation.state, "confirmed");
    assert.equal(result.body.operation.method, "delete"); assert.equal(result.body.operation.destination, null);
    assert.equal(result.body.operation.phase, "expunge"); assert.deepEqual(await t.sourceRows(), before);
    assert.equal(t.calls.filter(line => / UID STORE 2 \+FLAGS.SILENT \(\\Deleted\)$/.test(line)).length, 1);
    assert.equal(t.calls.filter(line => / UID EXPUNGE 2$/.test(line)).length, 1);
    const opens = t.opens.length; assert.deepEqual((await t.remove(key)).body, result.body); assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});
test("original-key facts survive account and catalog changes without reconnect or new OAuth work", async () => {
  const t = await mutationOperationFixture(), key = crypto.randomUUID();
  try {
    const result = await t.mutate(key); assert.equal(result.body.operation.state, "confirmed"); const opens = t.opens.length;
    await t.h.db.prepare("UPDATE normal_accounts SET revision=revision+1,enabled=0 WHERE id=?").bind(t.id).run();
    await t.h.db.prepare("UPDATE normal_server_folder_catalogs SET folders='[]' WHERE account_id=?").bind(t.id).run();
    assert.deepEqual((await t.mutate(key)).body, result.body); assert.deepEqual((await t.operation(key)).body, result.body);
    assert.deepEqual((await t.latest()).body, result.body); assert.equal(t.opens.length, opens);
    assert.equal((await t.mutate(key, { destinationEpochId: crypto.randomUUID() })).status, 409);
  } finally { await t.close(); }
});
test("an explicitly synchronized empty destination has a usable epoch without inventing target cache rows", async () => {
  const mailboxes = mailboxData(); mailboxes.get("&Ti1lhw-").messages.clear();
  const t = await mutationOperationFixture({ mailboxes });
  try {
    assert.equal((await t.messages(t.destination)).body.items.length, 0);
    const before = await t.sourceRows(), result = await t.mutate(); assert.equal(result.body.operation.state, "confirmed", result.text);
    assert.deepEqual(await t.sourceRows(), before); assert.equal((await t.messages(t.destination)).body.items.length, 0);
  } finally { await t.close(); }
});
