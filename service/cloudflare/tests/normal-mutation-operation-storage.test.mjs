import assert from "node:assert/strict";
import { test } from "node:test";
import { mutationOperationFixture } from "./normal-mutation-operation-fixture.mjs";

for (const mode of ["before-insert", "after-insert", "after-dispatch", "before-finish", "after-finish"]) {
  test(`lost ${mode} acknowledgement never authorizes MOVE replay or a new-key bypass`, async () => {
    const t = await mutationOperationFixture({ testEntry: "./normal-mutation-operation-test-worker.ts", bindings: { TEST_MUTATION_FAILURE: mode } });
    const key = crypto.randomUUID();
    try {
      const result = await t.mutate(key);
      if (mode === "before-insert") {
        assert.equal(result.status, 503, result.text); assert.equal((await t.operation(key)).status, 404);
        assert.equal(t.calls.some(line => / UID MOVE /.test(line)), false);
        assert.equal((await t.mutate(key)).body.operation.state, "confirmed"); return;
      }
      const expected = { "after-insert": "pending", "after-dispatch": "unknown", "before-finish": "pending", "after-finish": "confirmed" }[mode];
      assert.equal(result.status, mode === "before-finish" ? 503 : mode === "after-dispatch" ? 202 : mode === "after-finish" ? 201 : 200, result.text);
      assert.equal((await t.operation(key)).body.operation.state, expected);
      const writes = t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, opens = t.opens.length;
      assert.equal(writes, ["before-finish", "after-finish"].includes(mode) ? 1 : 0);
      assert.equal((await t.mutate(key)).body.operation.state, expected);
      assert.equal((await t.mutate()).status, 409); assert.equal((await t.flag()).status, 409);
      assert.equal(t.opens.length, opens); assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, writes);
      await t.h.restart(); assert.equal((await t.mutate(key)).body.operation.state, expected); assert.equal(t.opens.length, opens);
      if (expected === "pending") {
        await t.h.db.prepare("UPDATE normal_remote_mutation_operations SET created_at=created_at-120 WHERE request_key=?").bind(key).run();
        assert.equal((await t.operation(key)).body.operation.state, "unknown"); assert.equal((await t.mutate()).status, 409);
        assert.equal((await t.h.db.prepare("SELECT state FROM normal_remote_mutation_operations WHERE request_key=?").bind(key).first()).state, "pending");
      }
    } finally { await t.close(); }
  });
}
for (const [name, options, phase, count] of [
  ["native MOVE", { copyResponse: ({ tag }) => `${tag} OK accepted without mapping\r\n` }, "move", 1],
  ["COPY", { capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", copyResponse: ({ tag }) => `${tag} OK accepted without mapping\r\n` }, "copy", 1],
  ["Deleted", { capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", storeResponse: tag => `${tag} NO after effect\r\n` }, "mark-deleted", 2],
  ["EXPUNGE", { capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", expungeResponse: tag => `${tag} NO after effect\r\n` }, "expunge", 3],
]) test(`ambiguous ${name} records its last irreversible phase and permanently stops`, async () => {
  const t = await mutationOperationFixture(options), key = crypto.randomUUID();
  try {
    const before = await t.sourceRows(), result = await t.mutate(key);
    assert.equal(result.status, 202, result.text); assert.equal(result.body.operation.state, "unknown"); assert.equal(result.body.operation.phase, phase);
    assert.equal(result.body.operation.sourceRemoved, false); assert.deepEqual(await t.sourceRows(), before);
    assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, count);
    const opens = t.opens.length; assert.deepEqual((await t.mutate(key)).body, result.body); assert.equal((await t.remove()).status, 409);
    assert.equal(t.opens.length, opens);
  } finally { await t.close(); }
});
test("legal native MOVE mapping survives a failed final source-removal confirmation", async () => {
  const t = await mutationOperationFixture({ keepSource: true });
  try {
    const result = await t.mutate(); assert.equal(result.status, 202, result.text); assert.equal(result.body.operation.state, "unknown");
    assert.deepEqual(result.body.operation.destination, { uidValidity: "42", uid: 501 }); assert.equal(result.body.operation.sourceRemoved, false);
    assert.equal(t.calls.filter(line => / UID MOVE /.test(line)).length, 1); assert.equal((await t.mutate()).status, 409);
  } finally { await t.close(); }
});
test("lost COPYUID observation acknowledgement retains evidence but never advances to Deleted", async () => {
  const t = await mutationOperationFixture({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", testEntry: "./normal-mutation-operation-test-worker.ts",
    bindings: { TEST_MUTATION_FAILURE: "after-observation" } });
  try {
    const result = await t.mutate(); assert.equal(result.body.operation.state, "unknown", result.text);
    assert.deepEqual(result.body.operation.destination, { uidValidity: "42", uid: 501 }); assert.equal(result.body.operation.phase, "copy");
    assert.equal(t.calls.filter(line => / UID (MOVE|COPY|STORE|EXPUNGE) /.test(line)).length, 1);
  } finally { await t.close(); }
});
