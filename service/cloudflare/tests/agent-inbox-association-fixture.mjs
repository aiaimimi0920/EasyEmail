import { agentInboxFixture } from "./agent-inbox-fixture.mjs";
import { agentSmtpBindings, agentSmtpInput } from "./agent-smtp-fixture.mjs";
import { createService, expect } from "./agent-services-fixture.mjs";

export async function agentAssociationFixture(options = {}) {
  const t = await agentInboxFixture({ ...options, bindings: { ...agentSmtpBindings, ...options.bindings } });
  try {
    expect(await t.h.request(`${t.base}/smtp`, { method: "PUT", cookie: t.alice.cookie, body: agentSmtpInput, headers: { "idempotency-key": crypto.randomUUID() } }));
    const serviceId = expect(await createService(t.h, t.alice, { displayName: "远程任务", emailAddress: "agent@example.test", trustLevel: "trusted" }), 201).operation.serviceId;
    return { ...t, serviceId,
      async task({ submitted = true, ...fields } = {}) {
        const task = expect(await t.h.request("/api/v1/agent-tasks", { method: "POST", cookie: t.alice.cookie,
          headers: { "idempotency-key": crypto.randomUUID() }, body: { serviceId, serviceVersion: 1, senderAccountId: t.id, accountRevision: 1,
            smtpRevision: 1, subject: "回信关联合成任务", text: "任务正文", ...fields } }), 201).task;
        // Association-only fixture: durable dispatch evidence, not a claim of SMTP transport or delivery acceptance.
        if (submitted) await t.h.db.prepare("UPDATE agent_outgoing_messages SET submitted_at=unixepoch() WHERE id=?").bind(task.outgoingId).run();
        return task;
      },
    };
  } catch (error) { await t.close(); throw error; }
}
