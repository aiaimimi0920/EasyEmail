import { agentAssociationFixture } from "./agent-inbox-association-fixture.mjs";
import { agentReply } from "./agent-inbox-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

export async function agentReviewFixture(options = {}) {
  const t = await agentAssociationFixture(options);
  try {
    const task = await t.task();
    t.scenario({ uidNext: 2, messages: new Map([[1, agentReply(task.messageId, options.linked ? {} : { headers: "" })]]) });
    expect(await t.receive());
    const message = options.through ? null : expect(await t.messages()).items[0];
    return { ...t, firstTask: task, incoming: message,
      input: (state, target = null, revision = 0) => ({ accountRevision: 1, epochId: message.epochId, expectedRevision: revision, state, threadId: target }),
      review: (body, key = crypto.randomUUID(), extra = {}) => t.h.request(`${t.base}/messages/${message.id}/review`, { method: "PUT", cookie: t.alice.cookie,
        body, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
      reviewReceipt: (key, extra = {}) => t.h.request(`${t.base}/review-operations/${key}`, { cookie: t.alice.cookie, ...extra }),
      targets: (query = "", extra = {}) => t.h.request(`${t.base}/messages/${message.id}/review-targets${query}`, { cookie: t.alice.cookie, ...extra }),
    };
  } catch (error) { await t.close(); throw error; }
}
