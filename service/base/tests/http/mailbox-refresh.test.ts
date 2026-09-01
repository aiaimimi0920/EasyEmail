import { describe, expect, it } from "vitest";
import { EasyEmailError } from "../../src/domain/errors.js";
import type { ProviderInstance, ProviderTypeDefinition } from "../../src/domain/models.js";
import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import type { MailProviderAdapter } from "../../src/providers/contracts.js";
import { createBootstrappedEasyEmailService } from "../../src/service/bootstrap.js";

const NOW = new Date("2026-09-01T00:00:00.000Z");

const providerType: ProviderTypeDefinition = {
  key: "mailtm",
  displayName: "Refresh test provider",
  description: "Deterministic provider for mailbox refresh tests",
  supportsDynamicProvisioning: false,
  defaultStrategyKey: "dynamic-priority",
  tags: ["external"],
};

const providerInstance: ProviderInstance = {
  id: "mailtm-refresh-test",
  providerTypeKey: "mailtm",
  displayName: "Refresh test instance",
  status: "active",
  runtimeKind: "external",
  connectorKind: "test",
  shared: true,
  costTier: "free",
  healthScore: 1,
  averageLatencyMs: 1,
  connectionRef: "test://refresh",
  hostBindings: [],
  groupKeys: [],
  metadata: {},
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
};

function createRefreshFixture() {
  let mailboxIndex = 0;
  const syncCalls = new Map<string, number>();
  const codeSessionIds = new Set<string>();
  const failingSessionIds = new Set<string>();
  const adapter: MailProviderAdapter = {
    typeKey: "mailtm",
    async createMailboxSession({ request, instance, now }) {
      mailboxIndex += 1;
      return {
        id: `mailbox-${mailboxIndex}`,
        hostId: request.hostId,
        providerTypeKey: "mailtm",
        providerInstanceId: instance.id,
        emailAddress: `mailbox-${mailboxIndex}@example.test`,
        mailboxRef: `refresh:${mailboxIndex}`,
        status: "open",
        createdAt: now.toISOString(),
        metadata: {},
      };
    },
    async syncMailboxCode({ session }) {
      syncCalls.set(session.id, (syncCalls.get(session.id) ?? 0) + 1);
      if (failingSessionIds.has(session.id)) {
        throw new EasyEmailError("UPSTREAM_REFRESH_FAILED", "private upstream credential leaked");
      }
      const hasCode = codeSessionIds.has(session.id);
      return {
        id: `${session.id}-message`,
        sessionId: session.id,
        providerInstanceId: session.providerInstanceId,
        observedAt: "2026-09-01T00:05:00.000Z",
        subject: "Refresh result",
        textBody: hasCode ? "Verification code 123456" : "No code yet",
        ...(hasCode
          ? {
              extractedCode: "123456",
              extractedCandidates: ["123456"],
              codeSource: "text" as const,
            }
          : {}),
      };
    },
    async probeInstance() {
      return { ok: true, detail: "refresh_test_ok", averageLatencyMs: 1 };
    },
  };
  const service = createBootstrappedEasyEmailService({
    providerTypes: [providerType],
    providerInstances: [providerInstance],
    adapters: [adapter],
  }, NOW);
  const handler = new EasyEmailHttpHandler(service);

  async function open(hostId: string) {
    return service.openMailbox({
      hostId,
      providerTypeKey: "mailtm",
      provisionMode: "reuse-only",
      bindingMode: "shared-instance",
    }, NOW);
  }

  return { codeSessionIds, failingSessionIds, handler, open, service, syncCalls };
}

describe("mailbox refresh HTTP handler", () => {
  it("returns a not-found error for an unknown session and rejects an empty host", async () => {
    const { handler } = createRefreshFixture();

    await expect(handler.refreshMailbox("missing-session")).rejects.toMatchObject({
      code: "MAILBOX_SESSION_NOT_FOUND",
    });
    await expect(handler.refreshAnonymousMailboxes({ hostId: "  " })).rejects.toMatchObject({
      code: "INVALID_QUERY",
    });
  });

  it("owns single and host refresh orchestration without duplicate inserts or cross-host polling", async () => {
    const { codeSessionIds, failingSessionIds, handler, open, service, syncCalls } = createRefreshFixture();
    const first = await open("host-a");
    const resolvesOnRefresh = await open("host-a");
    const otherHost = await open("host-b");
    const failsOnRefresh = await open("host-a");
    codeSessionIds.add(resolvesOnRefresh.session.id);
    failingSessionIds.add(failsOnRefresh.session.id);

    await expect(handler.refreshMailbox(first.session.id)).resolves.toEqual({
      refresh: {
        fetchedCount: 1,
        insertedCount: 1,
        skippedCount: 0,
        failedCount: 0,
        refreshedSessionIds: [first.session.id],
        skippedSessionIds: [],
        failures: [],
      },
    });
    const repeated = await handler.refreshMailbox(first.session.id);
    expect(repeated.refresh).toMatchObject({ fetchedCount: 0, insertedCount: 0 });

    const batch = await handler.refreshAnonymousMailboxes({ hostId: "host-a" });
    expect(batch.refresh).toEqual({
      fetchedCount: 1,
      insertedCount: 1,
      skippedCount: 0,
      failedCount: 1,
      refreshedSessionIds: [first.session.id, resolvesOnRefresh.session.id],
      skippedSessionIds: [],
      failures: [{
        sessionId: failsOnRefresh.session.id,
        errorCode: "UPSTREAM_REFRESH_FAILED",
      }],
    });
    expect(JSON.stringify(batch)).not.toContain("private upstream credential leaked");
    await expect(handler.refreshMailbox(failsOnRefresh.session.id)).rejects.toMatchObject({
      code: "UPSTREAM_REFRESH_FAILED",
      message: `Unable to refresh mailbox session ${failsOnRefresh.session.id}.`,
    });
    expect(syncCalls.get(otherHost.session.id)).toBeUndefined();
    expect(service.getSnapshot().sessions.find(
      (session) => session.id === resolvesOnRefresh.session.id,
    )?.status).toBe("resolved");

    const nextBatch = await handler.refreshAnonymousMailboxes({ hostId: "host-a" });
    expect(nextBatch.refresh).toMatchObject({
      fetchedCount: 0,
      insertedCount: 0,
      skippedCount: 1,
      failedCount: 1,
      skippedSessionIds: [resolvesOnRefresh.session.id],
    });
    await expect(handler.refreshMailbox(resolvesOnRefresh.session.id)).resolves.toMatchObject({
      refresh: {
        fetchedCount: 0,
        insertedCount: 0,
        skippedCount: 1,
        failedCount: 0,
        refreshedSessionIds: [],
        skippedSessionIds: [resolvesOnRefresh.session.id],
        failures: [],
      },
    });
  });

  it("dispatches authenticated refresh routes and preserves 400/404 semantics", async () => {
    const { handler } = createRefreshFixture();
    const server = await createEasyEmailHttpServer(handler, { apiKey: "test-token" });
    const authenticatedHeaders = {
      authorization: "Bearer test-token",
      "content-type": "application/json",
    };

    try {
      const unauthenticated = await fetch(`${server.baseUrl}/mail/mailboxes/anonymous/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: "host-a" }),
      });
      expect(unauthenticated.status).toBe(401);

      const batch = await fetch(`${server.baseUrl}/mail/mailboxes/anonymous/refresh`, {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({ hostId: "host-a" }),
      });
      expect(batch.status).toBe(200);
      await expect(batch.json()).resolves.toMatchObject({
        refresh: { fetchedCount: 0, insertedCount: 0, failedCount: 0 },
      });

      const invalidBatch = await fetch(`${server.baseUrl}/mail/mailboxes/anonymous/refresh`, {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({ hostId: "" }),
      });
      expect(invalidBatch.status).toBe(400);

      const missing = await fetch(`${server.baseUrl}/mail/mailboxes/missing%2Fsession/refresh`, {
        method: "POST",
        headers: { authorization: "Bearer test-token" },
      });
      expect(missing.status).toBe(404);
      await expect(missing.json()).resolves.toMatchObject({ code: "MAILBOX_SESSION_NOT_FOUND" });

      const missingSend = await fetch(`${server.baseUrl}/mail/mailboxes/send`, {
        method: "POST",
        headers: authenticatedHeaders,
        body: JSON.stringify({
          sessionId: "missing-session",
          toEmailAddress: "target@example.test",
          subject: "test",
        }),
      });
      expect(missingSend.status).toBe(404);
      await expect(missingSend.json()).resolves.toMatchObject({ code: "MAILBOX_SESSION_NOT_FOUND" });
    } finally {
      await server.close();
    }
  });
});
