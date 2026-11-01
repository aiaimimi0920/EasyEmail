import { normalAttachmentsFixture } from "./normal-attachments-fixture.mjs";
import { mailInput } from "./normal-send-fixture.mjs";

export async function normalQueueFixture(browser = false) {
  const t = await normalAttachmentsFixture(browser), root = `${t.path}/send-jobs`;
  return { ...t, root,
    enqueue(body = mailInput, key = crypto.randomUUID(), extra = {}) {
      return t.h.request(root, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body, ...extra });
    },
    get(id, extra = {}) { return t.h.request(`${root}/${id}`, { cookie: t.alice.cookie, ...extra }); },
    action(job, kind, key = crypto.randomUUID(), extra = {}) {
      return t.h.request(`${root}/${job.id}/${kind}`, { method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body: { expectedRevision: job.revision }, ...extra });
    },
    tick() { return t.h.scheduled(Date.now(), "* * * * *"); },
  };
}
