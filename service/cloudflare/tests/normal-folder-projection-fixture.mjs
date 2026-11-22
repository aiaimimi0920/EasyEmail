import assert from "node:assert/strict";
import { normalFolderInboxFixture } from "./normal-folder-inbox-fixture.mjs";
import { normalListMail } from "./normal-subscriptions-fixture.mjs";

export const folderMail = (id, folder) => new TextEncoder().encode(new TextDecoder().decode(normalListMail(id, {
  subject: `${folder} projection ${id}`,
})).replace("To: alice@example.test", `To: ${folder === "INBOX" ? "alice" : "recipient"}@example.test`)
  .replace("Content-Type:", "References: <shared-root@example.test>\r\nContent-Type:"));
export const projectionMailboxes = (count = 2) => new Map(["INBOX", "Sent", "&Ti1lhw-"].map(folder => [folder, {
  validity: "42", uidNext: count + 1, messages: new Map(Array.from({ length: count }, (_, i) => [i + 1, folderMail(i + 1, folder)])),
}]));
export const expect = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
export async function folderProjectionFixture(options = {}) {
  const t = await normalFolderInboxFixture({ mailboxes: projectionMailboxes(), ...options });
  return { ...t,
    list(kind = "messages", query = "") { return t.request(`/api/v1/${kind}?sources=normal&folder=all${query ? `&${query}` : ""}`); },
    members(kind, item, query = "") { return t.request(kind === "subscriptions"
      ? `/api/v1/normal-subscriptions/${t.id}/${item.id}/messages?epochId=${item.epochId}&folder=all${query ? `&${query}` : ""}`
      : `/api/v1/conversations/${item.id}/messages?sources=normal&accountId=${t.id}&folder=all${query ? `&${query}` : ""}`); },
    hide(item, hidden = true, key = crypto.randomUUID(), extra = {}) { return t.request(`/api/v1/normal-subscriptions/${t.id}/${item.id}`, {
      method: "PATCH", headers: { "idempotency-key": key }, body: { expectedEpochId: item.epochId, expectedVersion: item.version, hidden }, ...extra,
    }); },
    async receiveAll(count = 2) { for (const folder of ["INBOX", "Sent", "&Ti1lhw-"]) for (let i = 0; i < Math.ceil(count / 3); i++) {
      assert.equal(expect(await t.receive(folder)).request.state, "committed");
    } },
  };
}
