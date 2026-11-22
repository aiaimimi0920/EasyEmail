import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailClient } from "../dist/index.js";

test("M7B Agent Mail SDK methods call canonical /mail/agent/* HTTP routes", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:18085",
    apiKey: "sdk-m7b-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const parsed = new URL(url);
      if (parsed.pathname === "/mail/agent/accounts" && init.method === "POST") {
        return new Response(
          JSON.stringify({
            account: {
              id: "acct_v1_agent",
              scope: "agent",
              kind: "agent_owned",
              displayName: "Agent Bot",
              primaryAddress: "bot@agents.local",
              status: "ready",
              authStatus: "valid",
              receiveStatus: "enabled",
              sendStatus: "enabled",
              listedInAllAccounts: false,
              version: 1,
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
              credentialRefs: [],
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/agent/accounts" && init.method === "GET") {
        return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
      }
      if (parsed.pathname === "/mail/agent/services" && init.method === "POST") {
        return new Response(
          JSON.stringify({
            service: {
              id: "agsvc_v1_1",
              displayName: "Planner Bot",
              emailAddress: "planner@agents.example",
              serviceKind: "email_agent",
              trustLevel: "trusted",
              status: "active",
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
            },
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/agent/services" && init.method === "GET") {
        return new Response(JSON.stringify({ services: [] }), { status: 200 });
      }
      if (parsed.pathname === "/mail/agent/tasks" && init.method === "POST") {
        return new Response(
          JSON.stringify({
            thread: {
              id: "agthread_v1_1",
              agentServiceId: "agsvc_v1_1",
              senderAccountId: "acct_v1_agent",
              subject: "Run task",
              status: "awaiting_reply",
              correlationKey: "agent-1",
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
            },
            agentMessage: {
              id: "agmsg_v1_1",
              threadId: "agthread_v1_1",
              messageId: "msg_v1_1",
              direction: "outgoing",
              semanticRole: "task_request",
              parsedStatus: "queued",
              createdAt: "2026-09-25T00:00:00.000Z",
            },
            queueItem: {
              id: "send_v1_1",
              accountId: "acct_v1_agent",
              accountScope: "agent",
              sourceId: "smtp:acct_v1_agent",
              messageId: "msg_v1_1",
              senderAddress: "bot@agents.local",
              smtpHost: "smtp.agents.local",
              smtpPort: 465,
              smtpSecurity: "tls",
              smtpUsername: "bot@agents.local",
              credentialRefId: "cref_1",
              targetAddress: "planner@agents.example",
              ccAddresses: [],
              bccAddresses: [],
              subject: "Run task",
              payloadFingerprint: "fp1",
              status: "queued",
              attemptCount: 0,
              version: 1,
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
            },
            deduplicated: false,
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname === "/mail/agent/threads" && init.method === "GET") {
        return new Response(JSON.stringify({ threads: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          detail: {
            thread: {
              id: "agthread/1",
              agentServiceId: "agsvc_v1_1",
              senderAccountId: "acct_v1_agent",
              subject: "Run task",
              status: "in_progress",
              correlationKey: "agent-1",
              createdAt: "2026-09-25T00:00:00.000Z",
              updatedAt: "2026-09-25T00:00:00.000Z",
            },
            messages: [],
          },
        }),
        { status: 200 },
      );
    },
  });

  const createdAcct = await client.createAgentMailAccount({
    displayName: "Agent Bot",
    emailAddress: "bot@agents.local",
  });
  assert.equal(createdAcct.scope, "agent");

  const acctList = await client.listAgentMailAccounts({ limit: 25 });
  assert.deepEqual(acctList.accounts, []);
  assert.match(calls[1].url, /\/mail\/agent\/accounts\?limit=25$/);

  const createdSvc = await client.createAgentMailService({
    displayName: "Planner Bot",
    emailAddress: "planner@agents.example",
    trustLevel: "trusted",
  });
  assert.equal(createdSvc.id, "agsvc_v1_1");

  const services = await client.listAgentMailServices();
  assert.deepEqual(services, []);

  const sent = await client.sendAgentMailTask(
    {
      agentServiceId: "agsvc_v1_1",
      senderAccountId: "acct_v1_agent",
      subject: "Run task",
      bodyText: "Hello agent",
      confirmRestricted: false,
    },
    { idempotencyKey: "task-idem-99" },
  );
  assert.equal(sent.queueItem.id, "send_v1_1");
  assert.equal(calls[4].headers["idempotency-key"], "task-idem-99");

  const threads = await client.listAgentMailThreads({ status: "needs_attention", limit: 10 });
  assert.deepEqual(threads, []);
  assert.match(calls[5].url, /\/mail\/agent\/threads\?status=needs_attention&limit=10$/);

  const detail = await client.getAgentMailThreadDetail("agthread/1");
  assert.equal(detail.thread.id, "agthread/1");
  assert.match(calls[6].url, /\/mail\/agent\/threads\/agthread%2F1$/);
});
