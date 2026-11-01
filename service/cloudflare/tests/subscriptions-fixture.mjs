import { cfMail } from "./provider-fixture.mjs";
export { conversationFixture as subscriptionsFixture, sync, expect } from "./conversations-fixture.mjs";
export const listHeaders = (extra = {}) => ({ version: 1, listId: "Updates <updates.example.test>",
  unsubscribe: "<https://unsubscribe.example.test/remove?token=synthetic>, <mailto:leave@example.test?subject=unsubscribe>",
  unsubscribePost: "List-Unsubscribe=One-Click", precedence: "bulk", listPost: "", listHelp: "", feedbackId: "", limited: false, ...extra });
export const listMail = (box, id, extra = {}) => ({ ...cfMail(box.address, id, `Newsletter content ${id}`, `2026-10-28 01:${String(id % 60).padStart(2, "0")}:00`),
  subject: `Newsletter ${id}`, subscription_headers: listHeaders(), ...extra });
export const subscriptions = (h, user, query = "", extra = {}) => h.request(`/api/v1/subscriptions?${query}`, { cookie: user.cookie, ...extra });
export const subscriptionPath = item => `/api/v1/subscriptions/${item.mailboxId}/${item.id}`;
export const subscriptionMembers = (h, user, item, query = "", extra = {}) => h.request(`${subscriptionPath(item)}/messages?${query}`, { cookie: user.cookie, ...extra });
export const hideSubscription = (h, user, item, hidden, key = crypto.randomUUID(), extra = {}) => h.request(subscriptionPath(item), {
  cookie: user.cookie, method: "PATCH", headers: { "idempotency-key": key }, body: { expectedVersion: item.version, hidden }, ...extra });
