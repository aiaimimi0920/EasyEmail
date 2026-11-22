import assert from "node:assert/strict";
import { normalAccessFixture } from "./normal-access-fixture.mjs";

export function normalThreadMail(own, refs = "", subject = "Normal thread", parent = "") {
  return new TextEncoder().encode(`From: Sender <sender@example.test>\r\nTo: alice@example.test\r\nSubject: ${subject}\r\n` +
    `${own ? `Message-ID: ${own}\r\n` : ""}${refs ? `References: ${refs}\r\n` : ""}${parent ? `In-Reply-To: ${parent}\r\n` : ""}` +
    `Content-Type: text/plain; charset=utf-8\r\n\r\nContent ${subject}\r\n`);
}
export async function normalConversationFixture(options = {}) {
  const messages = options.messages ?? new Map([[1, normalThreadMail("<child@example.test>", "<root@example.test>", "Needle child")],
    [2, normalThreadMail("<root@example.test>", "", "Late parent")], [3, normalThreadMail("<other@example.test>", "", "Other")]]);
  const t = await normalAccessFixture({ ...options, messages, uidNext: options.uidNext ?? messages.size + 1 });
  return { ...t, messages,
    list(query = "sources=normal&folder=all", extra = {}) { return t.h.request(`/api/v1/conversations?${query}`, { cookie: t.alice.cookie, ...extra }); },
    members(id, query = `sources=normal&accountId=${t.id}&folder=all`, extra = {}) {
      return t.h.request(`/api/v1/conversations/${id}/messages?${query}`, { cookie: t.alice.cookie, ...extra });
    },
    async receiveAll(count = messages.size) {
      for (let i = 0; i < Math.ceil(count / 3); i++) {
        const result = await t.receive(); assert.equal(result.body.request.state, "committed", result.text);
      }
    },
  };
}
export const expect = (result, status = 200) => { assert.equal(result.status, status, result.text); return result.body; };
