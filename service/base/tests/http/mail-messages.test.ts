import { describe, expect, it } from "vitest";

import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";
import { createEasyEmailService } from "../../src/service/easy-email-service.js";
import { MailMessageService } from "../../src/service/mail-messages.js";
import { MailVerificationService } from "../../src/service/mail-verifications.js";

const AUTH = { authorization: "Bearer m4-http-test-token" };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };
const NOW = new Date("2026-09-03T03:00:00.000Z");

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "M4 HTTP Provider",
  description: "Deterministic provider for M4 HTTP route tests",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm-m4-http",
  providerTypeKey: "mailtm",
  displayName: "Mail.tm HTTP",
  status: "active",
  runtimeKind: "external",
  connectorKind: "test",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 1,
  connectionRef: "test://m4-http",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

describe("M4 aggregated messages, drafts, and verification HTTP resources", () => {
  it("dispatches all 13 M4 operations, enforces bearer auth and agent scope isolation, and preserves local mutations", async () => {
    const database = new SqliteRelationalDatabase({
      databasePath: ":memory:",
      now: () => NOW,
    });
    const adapter: MailProviderAdapter = {
      typeKey: "mailtm",
      async createMailboxSession({ request, instance, now }) {
        return {
          id: "ses_http_1",
          hostId: request.hostId,
          providerTypeKey: "mailtm",
          providerInstanceId: instance.id,
          emailAddress: "inbox-http@example.test",
          mailboxRef: "ref:http-1",
          status: "open",
          createdAt: now.toISOString(),
          metadata: {},
        };
      },
      async syncMailboxCode({ session }) {
        return {
          id: "obs_http_code_1",
          sessionId: session.id,
          providerInstanceId: providerInstance.id,
          observedAt: "2026-09-03T03:02:00.000Z",
          sender: "Acme <security@acme.example>",
          subject: "Your Acme code is 654321",
          textBody: "Enter verification code 654321.",
          htmlBody: '<p>Code <b>654321</b></p><script>bad()</script>',
          extractedCode: "654321",
          extractedCandidates: ["654321"],
          codeSource: "subject",
        };
      },
      async probeInstance() {
        return { ok: true, detail: "m4_http_ok", averageLatencyMs: 1 };
      },
    };
    const coreService = createBootstrappedEasyEmailService(
      {
        providerTypes: [providerType],
        providerInstances: [providerInstance],
        adapters: [adapter],
      },
      NOW,
    );
    const accounts = new MailAccountService(database, () => NOW);
    const verifications = new MailVerificationService(database, database, () => NOW, {
      easyEmailService: coreService,
    });
    const messages = new MailMessageService(database, () => NOW, {
      accountRepository: database,
      easyEmailService: coreService,
      verificationService: verifications,
    });
    verifications.setBeforeQueryHook(async () => {
      await messages.ingestObservedMessages();
    });

    const handler = new EasyEmailHttpHandler(
      coreService,
      undefined,
      undefined,
      undefined,
      accounts,
      messages,
      verifications,
    );
    const server = await createEasyEmailHttpServer(handler, { apiKey: "m4-http-test-token" });

    try {
      const unauthorized = await fetch(`${server.baseUrl}/mail/messages`);
      expect(unauthorized.status).toBe(401);

      const workAccount = await accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "Work",
        primaryAddress: "work@example.com",
      });
      const agentAccount = await accounts.createAccount({
        kind: "agent_owned",
        scope: "agent",
        displayName: "Agent",
        primaryAddress: "agent@example.com",
      });

      const agentMessage = await messages.ingestExternalMessage({
        sourceKind: "agent",
        sourceRefId: `agent:${agentAccount.id}`,
        accountId: agentAccount.id,
        externalMessageId: "agent-1",
        receivedAddress: "agent@example.com",
        providerLabel: "Agent",
        subject: "Agent task code 999888",
        sender: "coordinator@example.com",
        bodyText: "Verification code 999888",
        observedAt: "2026-09-03T03:01:00.000Z",
      });

      await coreService.openMailbox(
        {
          hostId: "desktop-host",
          providerTypeKey: "mailtm",
          provisionMode: "reuse-only",
          bindingMode: "shared-instance",
        },
        NOW,
      );

      const pollRes = await fetch(
        `${server.baseUrl}/mail/mailboxes/ses_http_1/verification/poll`,
        { method: "POST", headers: JSON_AUTH, body: "{}" },
      );
      expect(pollRes.status).toBe(200);
      await expect(pollRes.json()).resolves.toMatchObject({
        refresh: { insertedCount: 1 },
        detectedCode: { code: "654321", sessionId: "ses_http_1" },
      });

      const draftRes = await fetch(`${server.baseUrl}/mail/drafts`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          accountId: workAccount.id,
          targetAddress: "client@example.com",
          ccAddresses: ["lead@example.com"],
          subject: "Q4 Plan",
          bodyText: "Draft body",
          bodyHtml: "<p>Draft body</p>",
        }),
      });
      expect(draftRes.status).toBe(200);
      const draftBody = (await draftRes.json()) as { draft: { messageId: string } };

      const allListRes = await fetch(`${server.baseUrl}/mail/messages`, { headers: AUTH });
      expect(allListRes.status).toBe(200);
      const allList = (await allListRes.json()) as { messages: Array<{ id: string }> };
      expect(allList.messages.map((m) => m.id)).toEqual(
        expect.arrayContaining(["obs_http_code_1", draftBody.draft.messageId]),
      );
      expect(allList.messages.map((m) => m.id)).not.toContain(agentMessage.messageId);

      const crossScopeRes = await fetch(
        `${server.baseUrl}/mail/messages?scope=normal_account&accountId=${encodeURIComponent(agentAccount.id)}`,
        { headers: AUTH },
      );
      expect(crossScopeRes.status).toBe(400);
      await expect(crossScopeRes.json()).resolves.toMatchObject({
        code: "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
      });

      const hiddenAgentDetail = await fetch(
        `${server.baseUrl}/mail/messages/${encodeURIComponent(agentMessage.messageId)}`,
        { headers: AUTH },
      );
      expect(hiddenAgentDetail.status).toBe(404);

      const detailRes = await fetch(`${server.baseUrl}/mail/messages/obs_http_code_1`, {
        headers: AUTH,
      });
      expect(detailRes.status).toBe(200);
      const detailJson = (await detailRes.json()) as { message: { bodyHtml?: string; rawBodyHtml?: string } };
      expect(detailJson.message.bodyHtml).toContain("<b>654321</b>");
      expect(detailJson.message.bodyHtml).not.toContain("<script");
      expect(detailJson.message.rawBodyHtml).toBeUndefined();

      expect(
        (
          await fetch(`${server.baseUrl}/mail/messages/obs_http_code_1/flags`, {
            method: "PATCH",
            headers: JSON_AUTH,
            body: JSON.stringify({ flagName: "starred", enabled: true }),
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await fetch(`${server.baseUrl}/mail/messages/obs_http_code_1/labels`, {
            method: "PATCH",
            headers: JSON_AUTH,
            body: JSON.stringify({ labelName: "OTP", enabled: true }),
          })
        ).status,
      ).toBe(200);

      expect(
        (
          await fetch(`${server.baseUrl}/mail/messages/obs_http_code_1/folder`, {
            method: "PATCH",
            headers: JSON_AUTH,
            body: JSON.stringify({ folderName: "archive" }),
          })
        ).status,
      ).toBe(200);

      const reclassifyRes = await fetch(
        `${server.baseUrl}/mail/messages/obs_http_code_1/reclassify-verification`,
        { method: "POST", headers: JSON_AUTH, body: "{}" },
      );
      expect(reclassifyRes.status).toBe(200);
      await expect(reclassifyRes.json()).resolves.toMatchObject({
        verification: { code: "654321" },
      });

      const verificationsRes = await fetch(`${server.baseUrl}/mail/verifications`, {
        headers: AUTH,
      });
      expect(verificationsRes.status).toBe(200);
      const verificationsJson = (await verificationsRes.json()) as {
        verifications: Array<{ code: string }>;
      };
      expect(verificationsJson.verifications.map((item) => item.code)).toEqual(["654321"]);

      const localTrashRes = await fetch(
        `${server.baseUrl}/mail/messages/obs_http_code_1/local`,
        { method: "DELETE", headers: AUTH },
      );
      expect(localTrashRes.status).toBe(200);
      await expect(localTrashRes.json()).resolves.toMatchObject({
        action: { status: "deleted_to_trash", changed: true },
      });

      const emptyTrashRes = await fetch(`${server.baseUrl}/mail/trash`, {
        method: "DELETE",
        headers: JSON_AUTH,
        body: JSON.stringify({ messageIds: ["obs_http_code_1"] }),
      });
      expect(emptyTrashRes.status).toBe(200);
      await expect(emptyTrashRes.json()).resolves.toMatchObject({
        result: { requestedCount: 1, changedCount: 1, remoteAppliedCount: 0 },
      });

      const deleteDraftRes = await fetch(
        `${server.baseUrl}/mail/drafts/${encodeURIComponent(draftBody.draft.messageId)}`,
        { method: "DELETE", headers: AUTH },
      );
      expect(deleteDraftRes.status).toBe(200);

      const deleteForeverAgentRes = await fetch(
        `${server.baseUrl}/mail/messages/${encodeURIComponent(agentMessage.messageId)}`,
        { method: "DELETE", headers: AUTH },
      );
      expect(deleteForeverAgentRes.status).toBe(200);
    } finally {
      await server.close();
      database.close();
    }
  });

  it("fails closed with 503 when relational message or verification persistence is unavailable", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
    );
    try {
      const messagesUnavailable = await fetch(`${server.baseUrl}/mail/messages`);
      expect(messagesUnavailable.status).toBe(503);
      await expect(messagesUnavailable.json()).resolves.toMatchObject({
        code: "MESSAGES_PERSISTENCE_UNAVAILABLE",
      });

      const verificationsUnavailable = await fetch(`${server.baseUrl}/mail/verifications`);
      expect(verificationsUnavailable.status).toBe(503);
      await expect(verificationsUnavailable.json()).resolves.toMatchObject({
        code: "VERIFICATIONS_PERSISTENCE_UNAVAILABLE",
      });

      const malformed = await fetch(`${server.baseUrl}/mail/messages/%E0%A4%A`);
      expect(malformed.status).toBe(400);
      await expect(malformed.json()).resolves.toMatchObject({ code: "INVALID_MAIL_MESSAGE" });
    } finally {
      await server.close();
    }
  });
});
