import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentMailClient,
  type AgentMailHttpTransport,
} from "../src/api/agentMailClient.ts";

test("lists and creates Agent accounts, services, tasks, and thread details over canonical HTTP", async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const transport: AgentMailHttpTransport = {
    async listAgentMailAccounts(query) {
      calls.push({ method: "listAgentMailAccounts", args: [query] });
      return {
        accounts: [
          {
            id: "acct_v1_agent",
            scope: "agent",
            kind: "agent_owned",
            displayName: "Agent Bot",
            primaryAddress: "bot@agents.local",
            providerLabel: "Agent Mail",
            status: "ready",
            authStatus: "not_required",
            receiveStatus: "disabled",
            sendStatus: "disabled",
            listedInAllAccounts: false,
            version: 1,
            createdAt: "2026-09-25T00:00:00.000Z",
            updatedAt: "2026-09-25T00:00:00.000Z",
            credentialRefs: [],
          },
        ],
      };
    },
    async createAgentMailAccount(request) {
      calls.push({ method: "createAgentMailAccount", args: [request] });
      return {
        account: {
          id: "acct_v1_agent_new",
          scope: "agent",
          kind: "agent_owned",
          displayName: request.displayName,
          primaryAddress: request.emailAddress,
          status: "ready",
          authStatus: "not_required",
          receiveStatus: "disabled",
          sendStatus: "disabled",
          listedInAllAccounts: false,
          version: 1,
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
          credentialRefs: [],
        },
      };
    },
    async listAgentMailServices() {
      calls.push({ method: "listAgentMailServices", args: [] });
      return {
        services: [
          {
            id: "agsvc_v1_1",
            displayName: "Planner Bot",
            emailAddress: "planner@agents.example",
            description: "Primary planner",
            serviceKind: "email_agent",
            trustLevel: "trusted",
            defaultSenderAccountId: "acct_v1_agent",
            status: "active",
            createdAt: "2026-09-25T00:00:00.000Z",
            updatedAt: "2026-09-25T00:00:00.000Z",
          },
        ],
      };
    },
    async createAgentMailService(request) {
      calls.push({ method: "createAgentMailService", args: [request] });
      return {
        service: {
          id: "agsvc_v1_2",
          displayName: request.displayName,
          emailAddress: request.emailAddress,
          serviceKind: request.serviceKind ?? "email_agent",
          trustLevel: request.trustLevel,
          status: "active",
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
        },
      };
    },
    async sendAgentMailTask(request, options) {
      calls.push({ method: "sendAgentMailTask", args: [request, options] });
      return {
        thread: {
          id: "agthread_v1_1",
          agentServiceId: request.agentServiceId,
          senderAccountId: request.senderAccountId,
          subject: request.subject,
          status: "awaiting_reply",
          lastOutgoingMessageId: "msg_v1_1",
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
          accountId: request.senderAccountId,
          accountScope: "agent",
          sourceId: `smtp:${request.senderAccountId}`,
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
          subject: request.subject,
          payloadFingerprint: "fp1",
          status: "queued",
          attemptCount: 0,
          version: 1,
          createdAt: "2026-09-25T00:00:00.000Z",
          updatedAt: "2026-09-25T00:00:00.000Z",
        },
        deduplicated: false,
      };
    },
    async listAgentMailThreads(query) {
      calls.push({ method: "listAgentMailThreads", args: [query] });
      return {
        threads: [
          {
            id: "agthread_v1_1",
            agentServiceId: "agsvc_v1_1",
            senderAccountId: "acct_v1_agent",
            subject: "Weekly summary",
            status: "in_progress",
            lastOutgoingMessageId: "msg_v1_1",
            lastIncomingMessageId: "msg_v1_2",
            correlationKey: "agent-1",
            createdAt: "2026-09-25T00:00:00.000Z",
            updatedAt: "2026-09-25T00:01:00.000Z",
          },
        ],
      };
    },
    async getAgentMailThreadDetail(threadId) {
      calls.push({ method: "getAgentMailThreadDetail", args: [threadId] });
      return {
        detail: {
          thread: {
            id: threadId,
            agentServiceId: "agsvc_v1_1",
            senderAccountId: "acct_v1_agent",
            subject: "Weekly summary",
            status: "in_progress",
            correlationKey: "agent-1",
            createdAt: "2026-09-25T00:00:00.000Z",
            updatedAt: "2026-09-25T00:01:00.000Z",
          },
          messages: [
            {
              id: "agmsg_v1_1",
              threadId,
              messageId: "msg_v1_1",
              direction: "outgoing",
              semanticRole: "task_request",
              parsedStatus: "sent",
              createdAt: "2026-09-25T00:00:00.000Z",
            },
          ],
        },
      };
    },
  };

  const client = createAgentMailClient(transport);

  const accounts = await client.listAgentAccounts();
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0]?.scope, "agent");
  assert.equal(accounts[0]?.listed_in_all_accounts, false);

  const createdAcct = await client.addAgentAccount({
    display_name: "New Agent",
    email_address: "new-bot@agents.local",
  });
  assert.equal(createdAcct.id, "acct_v1_agent_new");
  assert.equal(createdAcct.primary_address, "new-bot@agents.local");

  const services = await client.listAgentServices();
  assert.equal(services[0]?.display_name, "Planner Bot");
  assert.equal(services[0]?.default_sender_account_id, "acct_v1_agent");

  const createdSvc = await client.addAgentService({
    display_name: "Ops Bot",
    email_address: "ops@agents.example",
    trust_level: "restricted",
  });
  assert.equal(createdSvc.id, "agsvc_v1_2");
  assert.equal(createdSvc.description, null);

  const sent = await client.sendAgentTask({
    agent_service_id: "agsvc_v1_1",
    sender_account_id: "acct_v1_agent",
    subject: "Weekly summary",
    body_text: "Compile M7B report",
    confirm_restricted: false,
    idempotency_key: "agent-idem-1",
  });
  assert.equal(sent.queue_id, "send_v1_1");
  assert.equal(sent.queue_status, "queued");
  assert.equal(sent.agent_message.parsed_status, "queued");

  const threads = await client.listAgentThreads({ status: "in_progress" });
  assert.equal(threads[0]?.last_incoming_message_id, "msg_v1_2");

  const detail = await client.getAgentThreadDetail({ thread_id: "agthread_v1_1" });
  assert.equal(detail.thread.id, "agthread_v1_1");
  assert.equal(detail.messages.length, 1);
  assert.equal(calls.length, 7);
});
