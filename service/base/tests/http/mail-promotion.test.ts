import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { resolveRelationalDatabasePath } from "../../src/persistence/relational/database.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

const API_KEY = "m7a-promote-test-api-key-0123456789abcdef";
const AUTH = { authorization: `Bearer ${API_KEY}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Mail.tm M7A Provider",
  description: "Deterministic provider for M7A promotion HTTP tests",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm-m7a-instance",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm Temporary",
  status: "active",
  runtimeKind: "external",
  connectorKind: "test",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 1,
  connectionRef: "test://m7a",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: "2026-09-05T08:00:00.000Z",
  updatedAt: "2026-09-05T08:00:00.000Z",
};

function createTestAdapter(): MailProviderAdapter {
  let seq = 0;
  return {
    typeKey: "mailtm",
    async createMailboxSession({ request, instance, now }) {
      seq += 1;
      return {
        id: `ses_m7a_${seq}`,
        hostId: request.hostId,
        providerTypeKey: "mailtm",
        providerInstanceId: instance.id,
        emailAddress: `temp-m7a-${seq}@example.test`,
        mailboxRef: `ref:m7a:${seq}`,
        status: "open",
        createdAt: now.toISOString(),
        metadata: {},
      };
    },
    async syncMailboxCode() {
      return undefined;
    },
    async probeInstance() {
      return { ok: true, detail: "m7a_ok", averageLatencyMs: 1 };
    },
  };
}

async function writeTestRuntimeConfig(root: string): Promise<string> {
  const configPath = join(root, "config.yaml");
  const stateFile = join(root, "state.json").replaceAll("\\", "/");
  await writeFile(
    configPath,
    [
      "server:",
      "  host: 127.0.0.1",
      "  port: 0",
      `  apiKey: "${API_KEY}"`,
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
  return configPath;
}

describe("M7A temporary mailbox promotion over HTTP", () => {
  it("promotes anonymous temporary mailboxes without copying messages, persists visibility across restarts, and routes subsequent arrivals to the promoted account", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-m7a-promote-"));
    const configPath = await writeTestRuntimeConfig(root);

    const buildConfig = async () =>
      loadEasyEmailServiceRuntimeConfigFromEnvironment({
        EASY_EMAIL_CONFIG_PATH: configPath,
        EASY_EMAIL_STATE_DIR: root,
      });

    let runtime = await startEasyEmailServiceRuntime({
      config: await buildConfig(),
      sendQueueWorkerEnabled: false,
      adapters: [createTestAdapter()],
      registrySeed: {
        providerTypes: [providerType],
        instances: [providerInstance],
      },
    });

    try {
      const openRes = await fetch(`${runtime.server.baseUrl}/mail/mailboxes/open`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          hostId: "github.com",
          provisionMode: "always-create-dedicated",
          bindingMode: "shared-instance",
          preferredProviderTypeKey: "mailtm",
        }),
      });
      expect(openRes.status).toBe(200);
      const {
        result: { session: activeSession },
      } = (await openRes.json()) as {
        result: { session: { id: string; emailAddress: string } };
      };

      const openExpiredRes = await fetch(`${runtime.server.baseUrl}/mail/mailboxes/open`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          hostId: "gitlab.com",
          provisionMode: "always-create-dedicated",
          bindingMode: "shared-instance",
          preferredProviderTypeKey: "mailtm",
        }),
      });
      expect(openExpiredRes.status).toBe(200);
      const {
        result: { session: releasedSession },
      } = (await openExpiredRes.json()) as {
        result: { session: { id: string; emailAddress: string } };
      };
      await fetch(`${runtime.server.baseUrl}/mail/mailboxes/release`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ sessionId: releasedSession.id }),
      });

      const obs1Res = await fetch(`${runtime.server.baseUrl}/mail/messages/observe`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          id: "obs_m7a_before_promote",
          sessionId: activeSession.id,
          providerInstanceId: providerInstance.id,
          observedAt: "2026-09-05T08:05:00.000Z",
          sender: "GitHub <noreply@github.com>",
          subject: "Verify device code 812904",
          textBody: "Your code is 812904",
          extractedCode: "812904",
          extractedCandidates: ["812904"],
        }),
      });
      expect(obs1Res.status).toBe(200);

      const unconfirmedRes = await fetch(
        `${runtime.server.baseUrl}/mail/mailboxes/${activeSession.id}/promote`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ confirmLifecycleAck: false }),
        },
      );
      expect(unconfirmedRes.status).toBe(400);
      expect(await unconfirmedRes.json()).toMatchObject({
        code: "TEMP_PROMOTE_CONFIRMATION_REQUIRED",
      });

      const promoteRes = await fetch(
        `${runtime.server.baseUrl}/mail/mailboxes/${activeSession.id}/promote`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({
            confirmLifecycleAck: true,
            displayName: "Promoted GitHub Temp",
          }),
        },
      );
      expect(promoteRes.status).toBe(200);
      const promotedPayload = (await promoteRes.json()) as {
        account: {
          id: string;
          kind: string;
          status: string;
          receiveStatus: string;
          sendStatus: string;
          primaryAddress: string;
          displayName: string;
        };
        session: { id: string; metadata: Record<string, string> };
        linkedMessageCount: number;
      };
      expect(promotedPayload.linkedMessageCount).toBe(1);
      expect(promotedPayload.account).toMatchObject({
        kind: "normal_upgraded_temp",
        status: "ready",
        receiveStatus: "enabled",
        sendStatus: "unsupported",
        primaryAddress: activeSession.emailAddress,
        displayName: "Promoted GitHub Temp",
      });
      expect(promotedPayload.session.metadata).toMatchObject({
        visibilityState: "upgraded",
        upgradedAccountId: promotedPayload.account.id,
      });

      const dupRes = await fetch(
        `${runtime.server.baseUrl}/mail/mailboxes/${activeSession.id}/promote`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ confirmLifecycleAck: true }),
        },
      );
      expect(dupRes.status).toBe(409);
      expect(await dupRes.json()).toMatchObject({ code: "TEMP_PROMOTE_NOT_AVAILABLE" });

      const promoteExpiredRes = await fetch(
        `${runtime.server.baseUrl}/mail/mailboxes/${releasedSession.id}/promote`,
        {
          method: "POST",
          headers: JSON_AUTH,
          body: JSON.stringify({ confirmLifecycleAck: true }),
        },
      );
      expect(promoteExpiredRes.status).toBe(200);
      const expiredPromoted = (await promoteExpiredRes.json()) as {
        account: { status: string; receiveStatus: string };
      };
      expect(expiredPromoted.account).toMatchObject({
        status: "history_only",
        receiveStatus: "expired",
      });

      const relationalDbPath = resolveRelationalDatabasePath(
        runtime.config.persistence.databasePath,
      );
      await runtime.close();

      const inspector = new DatabaseSync(relationalDbPath);
      try {
        const messageRows = inspector
          .prepare("SELECT id FROM mail_messages")
          .all() as Array<{ id: string }>;
        expect(messageRows).toHaveLength(1);
        const sourceRows = inspector
          .prepare("SELECT id, account_id FROM mail_message_sources")
          .all() as Array<{ id: string; account_id: string }>;
        expect(sourceRows).toHaveLength(1);
        expect(sourceRows[0]?.account_id).toBe(promotedPayload.account.id);
      } finally {
        inspector.close();
      }

      runtime = await startEasyEmailServiceRuntime({
        config: await buildConfig(),
        sendQueueWorkerEnabled: false,
        adapters: [createTestAdapter()],
        registrySeed: {
          providerTypes: [providerType],
          instances: [providerInstance],
        },
      });

      const sessionsAfterRestart = await fetch(
        `${runtime.server.baseUrl}/mail/query/mailbox-sessions`,
        { headers: AUTH },
      );
      const { sessions } = (await sessionsAfterRestart.json()) as {
        sessions: Array<{ id: string; metadata: Record<string, string> }>;
      };
      const persistedSession = sessions.find((item) => item.id === activeSession.id);
      expect(persistedSession?.metadata).toMatchObject({
        visibilityState: "upgraded",
        upgradedAccountId: promotedPayload.account.id,
      });

      const obs2Res = await fetch(`${runtime.server.baseUrl}/mail/messages/observe`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          id: "obs_m7a_after_restart",
          sessionId: activeSession.id,
          providerInstanceId: providerInstance.id,
          observedAt: "2026-09-05T08:15:00.000Z",
          sender: "GitHub <noreply@github.com>",
          subject: "Second notification after promotion",
          textBody: "Pull request merged.",
        }),
      });
      expect(obs2Res.status).toBe(200);

      const accountMessagesRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages?scope=promoted_account&accountId=${encodeURIComponent(promotedPayload.account.id)}`,
        { headers: AUTH },
      );
      expect(accountMessagesRes.status).toBe(200);
      const accountMessages = (await accountMessagesRes.json()) as {
        messages: Array<{ subject: string; accountId: string }>;
      };
      expect(accountMessages.messages).toHaveLength(2);
      expect(accountMessages.messages.map((item) => item.subject)).toEqual([
        "Second notification after promotion",
        "Verify device code 812904",
      ]);

      const anonymousMessagesRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages?scope=anonymous`,
        { headers: AUTH },
      );
      expect(anonymousMessagesRes.status).toBe(200);
      const anonymousMessages = (await anonymousMessagesRes.json()) as {
        messages: Array<{ id: string }>;
      };
      expect(anonymousMessages.messages).toHaveLength(0);

      const verificationsRes = await fetch(
        `${runtime.server.baseUrl}/mail/verifications?scope=promoted`,
        { headers: AUTH },
      );
      expect(verificationsRes.status).toBe(200);
      const { verifications } = (await verificationsRes.json()) as {
        verifications: Array<{ code: string }>;
      };
      expect(verifications.map((item) => item.code)).toEqual(["812904"]);
    } finally {
      await runtime.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
