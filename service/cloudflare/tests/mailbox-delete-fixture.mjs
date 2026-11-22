import assert from "node:assert/strict";
import { createHarness } from "./runtime-harness.mjs";
import { remoteFixture } from "./remote-fixture.mjs";
import { allocate } from "./provider-fixture.mjs";

export async function mailboxDeleteFixture(browser = false, through = null, remoteOptions = {}) {
  const f = await remoteFixture({ ...remoteOptions, fullSchema: true, legacyAuth: true });
  const configs = JSON.parse(f.bindings.PROVIDER_CONFIG);
  Object.assign(configs[0], { sendTransport: "worker", sendRecipients: ["recipient@example.test"] });
  const bindings = { ...f.bindings, PROVIDER_CONFIG: JSON.stringify(configs) };
  const h = await createHarness(bindings, browser, through), alice = await h.register(`mailbox-delete-${crypto.randomUUID()}`);
  return { f, h, alice, bindings,
    writes: () => f.calls.filter((call) => call.path === "/cf/api/address_deletions" && call.method === "POST"),
    async sample() {
      const response = await allocate(h, alice.cookie); assert.equal(response.status, 201, response.text);
      const box = response.body.mailbox;
      const remote = await f.db.prepare("SELECT id FROM address WHERE name=?").bind(box.address).first();
      const path = `/api/v1/mailboxes/${box.id}`, body = { confirmAddress: box.address, confirmMailboxId: box.id };
      return { box, remoteId: remote.id, path, endpoint: `${path}/remote-delete`, body };
    },
    remove(s, key = crypto.randomUUID(), extra = {}) {
      return h.request(s.endpoint, { method: "POST", cookie: alice.cookie, body: s.body, headers: { "idempotency-key": key }, ...extra });
    },
    check(s, extra = {}) { return h.request(`${s.endpoint}/check`, { method: "POST", cookie: alice.cookie, body: {}, ...extra }); },
    async close() { await h.close(); await f.close(); },
  };
}
