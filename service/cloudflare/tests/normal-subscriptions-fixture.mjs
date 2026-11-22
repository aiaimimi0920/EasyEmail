import assert from "node:assert/strict";
import { normalAccessFixture } from "./normal-access-fixture.mjs";
import { normalThreadMail } from "./normal-conversations-fixture.mjs";

export function normalListMail(id, { name = "Updates", listId = "updates.example.test", subject = `Newsletter ${id}`,
  unsubscribe = "<https://unsubscribe.example.test/leave>, <mailto:leave@example.test?subject=unsubscribe>" } = {}) {
  const raw = new TextDecoder().decode(normalThreadMail(`<list${id}@example.test>`, "", subject));
  return new TextEncoder().encode(raw.replace("Content-Type:", `List-ID: ${name} <${listId}>\r\nList-Unsubscribe: ${unsubscribe}\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\nContent-Type:`));
}
export const expect = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
export async function normalSubscriptionsFixture(options = {}) {
  const messages = options.messages ?? new Map([[1, normalListMail(1)], [2, normalListMail(2)], [3, normalThreadMail("<not-list@example.test>")]]);
  const t = await normalAccessFixture({ ...options, messages, uidNext: options.uidNext ?? messages.size + 1 });
  return { ...t, sourceMessages: messages,
    list(query = "sources=normal", extra = {}) { return t.h.request(`/api/v1/subscriptions?${query}`, { cookie: t.alice.cookie, ...extra }); },
    members(item, query = "", extra = {}) { return t.h.request(`/api/v1/normal-subscriptions/${item.accountId}/${item.id}/messages?epochId=${item.epochId}${query ? `&${query}` : ""}`, { cookie: t.alice.cookie, ...extra }); },
    hide(item, hidden = !item.hidden, key = crypto.randomUUID(), extra = {}) {
      return t.h.request(`/api/v1/normal-subscriptions/${item.accountId}/${item.id}`, { method: "PATCH", cookie: t.alice.cookie,
        headers: { "idempotency-key": key }, body: { expectedVersion: item.version, expectedEpochId: item.epochId, hidden }, ...extra });
    },
    operation(key, extra = {}) { return t.h.request(`/api/v1/normal-subscription-operations/${key}`, { cookie: t.alice.cookie, ...extra }); },
    async receiveAll() { for (let i = 0; i < Math.ceil(messages.size / 3); i++) assert.equal((await t.receive()).body.request.state, "committed"); },
  };
}
