import assert from "node:assert/strict";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { mutationScenario } from "./normal-mutation-protocol-fixture.mjs";

export async function mutationOperationFixture(options = {}) {
  const t = await normalFolderInboxFixture({ ...options, scenarioFactory: mutationScenario });
  try {
    const source = options.source ?? "Sent", destination = options.destination ?? "&Ti1lhw-";
    assert.equal((await t.receive(source)).body.request.state, "committed");
    assert.equal((await t.receive(destination)).body.request.state, "committed");
    const item = (await t.messages(source)).body.items[0], target = (await t.messages(destination)).body;
    const sourceBase = source === "INBOX" ? t.base : t.folderPath(source), path = `${sourceBase}/messages/${item.id}/remote-mutations`;
    const body = { expectedRevision: 1, epochId: item.epochId, action: "move", destinationFolderId: t.folder(destination).id,
      destinationEpochId: target.epochId, confirmRemoteChange: true };
    return { ...t, source, destination, sourceBase, path, item, body,
      mutate(key = crypto.randomUUID(), fields = {}, extra = {}) { return t.request(path, { method: "POST", headers: { "idempotency-key": key }, body: { ...body, ...fields }, ...extra }); },
      remove(key = crypto.randomUUID(), extra = {}) { return t.request(path, { method: "POST", headers: { "idempotency-key": key }, body: {
        expectedRevision: 1, epochId: item.epochId, action: "delete", confirmPermanentDelete: true }, ...extra }); },
      operation(key, extra = {}) { return t.request(`${sourceBase}/remote-mutation-operations/${key}`, extra); },
      latest(extra = {}) { return t.request(path, extra); },
      flag(key = crypto.randomUUID(), fields = {}, extra = {}) { return t.request(`${sourceBase}/messages/${item.id}/remote-flags`, {
        method: "POST", headers: { "idempotency-key": key }, body: { expectedRevision: 1, epochId: item.epochId,
          flag: "\\Flagged", value: true, acknowledgedUnknownId: null, ...fields }, ...extra }); },
      async sourceRows() { return (await t.h.db.prepare("SELECT * FROM normal_inbox_messages WHERE account_id=? ORDER BY id").bind(t.id).all()).results; },
    };
  } catch (error) { await t.close(); throw error; }
}
