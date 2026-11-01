import assert from "node:assert/strict";
import { test } from "node:test";
import { createHarness } from "./runtime-harness.mjs";
import { allocate } from "./provider-fixture.mjs";
import { sendFixture, sendRequest, sendCalls } from "./send-fixture.mjs";
import { selectGates } from "./account-race-fixture.mjs";
import { draftBody, saveDraft, deleteDraft, ok } from "./draft-fixture.mjs";

test("editing or deletion after the send authorization snapshot fences the actual reservation transaction", async () => {
  const f = await sendFixture(), gates = await selectGates(); let h, gate, pending;
  try {
    h = await createHarness({ ...f.bindings, ...gates.bindings }, false, null, new URL("./account-gated-worker.ts", import.meta.url));
    const user = await h.register("draft-racing-user"), response = await allocate(h, user.cookie);
    assert.equal(response.status, 201, response.text); const box = response.body.mailbox;
    for (const mode of ["edit", "delete"]) {
      const id = crypto.randomUUID(), body = draftBody(box.id);
      ok(await saveDraft(h, user.cookie, id, body), 201);
      gate = gates.hold(`draft-${mode}`, "draft");
      pending = sendRequest(h, user.cookie, box, crypto.randomUUID(), {
        to: body.to, subject: body.subject, text: body.text, draftId: id, draftRevision: 1,
      }, { headers: { ...gate.headers, "idempotency-key": crypto.randomUUID() } });
      await gate.entered();
      if (mode === "edit") ok(await saveDraft(h, user.cookie, id, draftBody(box.id, { expectedRevision: 1, text: "new device" })));
      else ok(await deleteDraft(h, user.cookie, id, 1));
      gate.release(); assert.equal((await pending).status, 409); pending = null;
      assert.equal(await h.db.prepare("SELECT COUNT(*) n FROM outgoing_messages").first("n"), 0);
      assert.equal(sendCalls(f).length, 0);
    }
  } finally { gate?.release(); await pending?.catch(() => {}); await h?.close(); await gates.close(); await f.close(); }
});
