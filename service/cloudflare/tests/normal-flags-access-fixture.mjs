import assert from "node:assert/strict";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { flagsScenario } from "./normal-flags-fixture.mjs";

export async function normalFlagsFixture(options = {}) {
  const t = await normalAccessFixture({ ...options, scenarioFactory: flagsScenario });
  try {
    assert.equal((await t.receive()).body.request.state, "committed");
    const message = (await t.messages()).body.items[0];
    const body = { expectedRevision: 1, epochId: message.epochId, flag: "\\Flagged", value: true, acknowledgedUnknownId: null };
    const path = `${t.base}/messages/${message.id}/remote-flags`;
    return { ...t, item: message, body, path,
      write(key = crypto.randomUUID(), fields = {}, extra = {}) { return t.h.request(path, {
        method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body: { ...body, ...fields }, ...extra }); },
      operation(key, extra = {}) { return t.h.request(`${t.base}/remote-flag-operations/${key}`, { cookie: t.alice.cookie, ...extra }); },
      latest(extra = {}) { return t.h.request(path, { cookie: t.alice.cookie, ...extra }); },
    };
  } catch (error) { await t.close(); throw error; }
}
