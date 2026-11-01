import { outboxFixture } from "./outbox-fixture.mjs";
import { sendBody } from "./send-fixture.mjs";

export async function queueFixture(options = {}) {
  const t = await outboxFixture(options);
  return { ...t,
    enqueue(body = sendBody, key = crypto.randomUUID(), extra = {}) {
      return t.h.request(`/api/v1/mailboxes/${t.box.id}/send-jobs`, { method: "POST", cookie: t.alice.cookie,
        headers: { "idempotency-key": key }, body, ...extra });
    },
    get(id, extra = {}) { return t.h.request(`/api/v1/send-jobs/${id}`, { cookie: t.alice.cookie, ...extra }); },
    action(job, kind, key = crypto.randomUUID(), extra = {}) {
      return t.h.request(`/api/v1/send-jobs/${job.id}/${kind}`, { method: "POST", cookie: t.alice.cookie,
        headers: { "idempotency-key": key }, body: { expectedRevision: job.revision }, ...extra });
    },
    tick() { return t.h.scheduled(Date.now(), "* * * * *"); },
  };
}
