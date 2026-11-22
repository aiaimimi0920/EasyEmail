import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

describe("M7B HTTP Agent Mail accounts, services, trust policies, and task idempotency", () => {
  it("isolates agent accounts from normal accounts, enforces service trust & sender scope, and deduplicates task enqueues", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-http-agent-policy-"));
    const apiKey = "m7b-policy-test-api-key-0123456789abcdef";
    const configPath = join(root, "config.yaml");
    const stateFile = join(root, "state.json").replaceAll("\\", "/");
    await writeFile(
      configPath,
      [
        "server:",
        "  host: 127.0.0.1",
        "  port: 0",
        `  apiKey: "${apiKey}"`,
        "  corsOrigins:",
        "    - http://tauri.localhost",
        "maintenance:",
        "  enabled: false",
        "persistence:",
        "  enabled: true",
        "  driver: file",
        `  filePath: "${stateFile}"`,
        "",
      ].join("\n"),
      "utf8",
    );

    const baseConfig = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: root,
    });
    const runtime = await startEasyEmailServiceRuntime({
      sendQueueWorkerEnabled: false,
      config: baseConfig,
    });

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      const unauth = await fetch(`${runtime.server.baseUrl}/mail/agent/accounts`);
      expect(unauth.status).toBe(401);

      const rawSecretAttempt = await fetch(`${runtime.server.baseUrl}/mail/agent/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Bad Agent",
          emailAddress: "bad@agents.local",
          password: "cleartext-secret-never-allowed",
        }),
      });
      expect(rawSecretAttempt.status).toBe(400);

      // Create normal account + Agent account and verify strict scope isolation
      const normalAcctRes = await fetch(`${runtime.server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "Personal Mailbox",
          primaryAddress: "human@example.com",
          smtp: { host: "smtp.example.com", port: 465, security: "tls", username: "human@example.com" },
          credentialRefs: [
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000701",
              credentialKind: "smtp_password",
              authMethod: "password",
            },
          ],
        }),
      });
      expect(normalAcctRes.status).toBe(200);
      const { account: normalAccount } = (await normalAcctRes.json()) as { account: { id: string } };

      const agentAcctRes = await fetch(`${runtime.server.baseUrl}/mail/agent/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Agent Runner",
          emailAddress: "bot-runner@agents.local",
          providerLabel: "Agent Mail",
          imap: { host: "imap.agents.local", port: 993, security: "tls", username: "bot-runner@agents.local" },
          smtp: { host: "smtp.agents.local", port: 465, security: "tls", username: "bot-runner@agents.local" },
          credentialRefs: [
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000702",
              credentialKind: "imap_password",
              authMethod: "password",
            },
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000703",
              credentialKind: "smtp_password",
              authMethod: "password",
            },
          ],
        }),
      });
      expect(agentAcctRes.status).toBe(200);
      const { account: agentAccount } = (await agentAcctRes.json()) as {
        account: { id: string; scope: string; kind: string; listedInAllAccounts: boolean; sendStatus: string };
      };
      expect(agentAccount.scope).toBe("agent");
      expect(agentAccount.kind).toBe("agent_owned");
      expect(agentAccount.listedInAllAccounts).toBe(false);
      expect(agentAccount.sendStatus).toBe("enabled");

      const normalList = (await (
        await fetch(`${runtime.server.baseUrl}/mail/accounts?scope=normal`, { headers })
      ).json()) as {
        accounts: Array<{ id: string }>;
      };
      expect(normalList.accounts.map((item) => item.id)).toEqual([
        "acct_anonymous_virtual",
        normalAccount.id,
      ]);

      const agentList = (await (await fetch(`${runtime.server.baseUrl}/mail/agent/accounts`, { headers })).json()) as {
        accounts: Array<{ id: string }>;
      };
      expect(agentList.accounts.map((item) => item.id)).toEqual([agentAccount.id]);

      // Register remote Agent services & enforce defaultSenderAccountId scope + duplicate email check
      const wrongDefaultSenderRes = await fetch(`${runtime.server.baseUrl}/mail/agent/services`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Wrong Default Sender",
          emailAddress: "wrong@agents.example",
          trustLevel: "trusted",
          defaultSenderAccountId: normalAccount.id,
        }),
      });
      expect(wrongDefaultSenderRes.status).toBe(409);

      const createService = async (payload: Record<string, unknown>) => {
        const res = await fetch(`${runtime.server.baseUrl}/mail/agent/services`, {
          method: "POST",
          headers,
          body: JSON.stringify(payload),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as { service: { id: string; emailAddress: string } };
        return body.service;
      };

      const plannerService = await createService({
        displayName: "Planner Bot",
        emailAddress: "Planner@Agents.Example",
        description: "Primary planning agent",
        trustLevel: "trusted",
        defaultSenderAccountId: agentAccount.id,
      });
      expect(plannerService.emailAddress).toBe("planner@agents.example");

      const restrictedService = await createService({
        displayName: "Restricted Ops Bot",
        emailAddress: "ops@agents.example",
        trustLevel: "restricted",
      });
      const blockedService = await createService({
        displayName: "Blocked Bot",
        emailAddress: "blocked@agents.example",
        trustLevel: "blocked",
      });

      const dupServiceRes = await fetch(`${runtime.server.baseUrl}/mail/agent/services`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          displayName: "Duplicate Planner",
          emailAddress: "planner@agents.example",
          trustLevel: "trusted",
        }),
      });
      expect(dupServiceRes.status).toBe(409);

      const servicesRes = await fetch(`${runtime.server.baseUrl}/mail/agent/services`, { headers });
      expect(servicesRes.status).toBe(200);
      const { services } = (await servicesRes.json()) as { services: Array<{ id: string }> };
      expect(services.map((s) => s.id)).toEqual([
        plannerService.id,
        restrictedService.id,
        blockedService.id,
      ]);

      // Policy checks on task enqueue
      const normalSenderTaskRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentServiceId: plannerService.id,
          senderAccountId: normalAccount.id,
          subject: "Forbidden Normal Send",
          bodyText: "Should fail",
          confirmRestricted: false,
        }),
      });
      expect(normalSenderTaskRes.status).toBe(409);

      const blockedTaskRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentServiceId: blockedService.id,
          senderAccountId: agentAccount.id,
          subject: "Blocked Target",
          bodyText: "Should fail",
          confirmRestricted: true,
        }),
      });
      expect(blockedTaskRes.status).toBe(422);

      const unconfirmedRestrictedRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentServiceId: restrictedService.id,
          senderAccountId: agentAccount.id,
          subject: "Restricted Task",
          bodyText: "Needs confirmation",
          confirmRestricted: false,
        }),
      });
      expect(unconfirmedRestrictedRes.status).toBe(409);

      const confirmedRestrictedRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          agentServiceId: restrictedService.id,
          senderAccountId: agentAccount.id,
          subject: "Confirmed Restricted Task",
          bodyText: "Approved payload",
          confirmRestricted: true,
        }),
      });
      expect(confirmedRestrictedRes.status).toBe(200);

      // Idempotency-Key deduplication & conflict detection
      const taskRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "idem-agent-task-1" },
        body: JSON.stringify({
          agentServiceId: plannerService.id,
          senderAccountId: agentAccount.id,
          subject: "Summarize weekly release metrics",
          bodyText: "Please compile release metrics for M7B.",
          confirmRestricted: false,
        }),
      });
      expect(taskRes.status).toBe(200);
      const created = (await taskRes.json()) as {
        thread: { id: string; status: string };
        agentMessage: { id: string; parsedStatus?: string };
        queueItem: { id: string; status: string };
        deduplicated: boolean;
      };
      expect(created.deduplicated).toBe(false);
      expect(created.thread.status).toBe("awaiting_reply");
      expect(created.agentMessage.parsedStatus).toBe("queued");

      const replayRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "idem-agent-task-1" },
        body: JSON.stringify({
          agentServiceId: plannerService.id,
          senderAccountId: agentAccount.id,
          subject: "Summarize weekly release metrics",
          bodyText: "Please compile release metrics for M7B.",
          confirmRestricted: false,
        }),
      });
      expect(replayRes.status).toBe(200);
      const replayed = (await replayRes.json()) as typeof created;
      expect(replayed.deduplicated).toBe(true);
      expect(replayed.thread.id).toBe(created.thread.id);

      const conflictRes = await fetch(`${runtime.server.baseUrl}/mail/agent/tasks`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": "idem-agent-task-1" },
        body: JSON.stringify({
          agentServiceId: plannerService.id,
          senderAccountId: agentAccount.id,
          subject: "Mutated subject with same key",
          bodyText: "Please compile release metrics for M7B.",
          confirmRestricted: false,
        }),
      });
      expect(conflictRes.status).toBe(409);

      const missingRes = await fetch(
        `${runtime.server.baseUrl}/mail/agent/threads/agthread_v1_missing`,
        { headers },
      );
      expect(missingRes.status).toBe(404);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
