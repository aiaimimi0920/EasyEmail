import { agentTasksFixture } from "./agent-tasks-fixture.mjs";
import { expect } from "./agent-services-fixture.mjs";

export async function agentFollowupsFixture(options = {}) {
  const t = await agentTasksFixture(options.browser ?? false, options.testEntry ?? new URL("./agent-followups-test-worker.ts", import.meta.url), options.resources, options.transport);
  const context = id => t.h.request(`/api/v1/agent-threads/${id}/followup-context`, { cookie: t.alice.cookie });
  return { ...t, context,
    async followupInput(id, fields = {}) {
      const c = expect(await context(id)).context;
      return { ...t.input, senderAccountId: c.senderAccountId, accountRevision: c.accountRevision, smtpRevision: c.smtpRevision,
        serviceId: c.serviceId, serviceVersion: c.serviceVersion, expectedThreadRevision: c.threadRevision,
        replyToType: "task", replyToId: id, confirmUncertain: false, ...fields };
    },
    followup: (id, body, key = crypto.randomUUID(), extra = {}) => t.h.request(`/api/v1/agent-threads/${id}/followups`, {
      method: "POST", cookie: t.alice.cookie, body, ...extra, headers: { "idempotency-key": key, ...extra.headers } }),
    followupRead: (id, extra = {}) => t.h.request(`/api/v1/agent-followups/${id}`, { cookie: t.alice.cookie, ...extra }),
    followupReceipt: (key, extra = {}) => t.h.request(`/api/v1/agent-followups?requestKey=${key}`, { cookie: t.alice.cookie, ...extra }),
    followupList: (id, query = "", extra = {}) => t.h.request(`/api/v1/agent-threads/${id}/followups${query}`, { cookie: t.alice.cookie, ...extra }),
  };
}
