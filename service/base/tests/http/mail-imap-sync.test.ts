import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";
import { ImapFlowTransport } from "../../src/service/imap-transport.js";
import { startStatefulLoopbackTlsImapServer } from "../helpers/stateful-loopback-tls-imap-server.js";

const currentDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(currentDir, "../../../../apps/desktop/scripts/fixtures");

interface CertModule {
  generateEphemeralLoopbackTlsCertificate(): { certPem: string; keyPem: string };
}

describe("M6 HTTP IMAP folder discovery, sync, lazy body hydration, remote actions, and offline fail-closed invariants", () => {
  it("syncs IMAP accounts over HTTP, hydrates bodies lazily, recovers from UIDVALIDITY resets and folder renames, executes remote actions, and fails closed when offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-http-imap-sync-"));
    const apiKey = "m6-http-test-api-key-0123456789abcdef";
    const imapSecret = "m6-imap-secret-canary-4411";

    const { generateEphemeralLoopbackTlsCertificate } = (await import(
      pathToFileURL(resolve(fixturesDir, "ephemeral-loopback-tls-cert.mjs")).href
    )) as CertModule;
    const { certPem, keyPem } = generateEphemeralLoopbackTlsCertificate();

    const imapServer = await startStatefulLoopbackTlsImapServer({
      certPem,
      keyPem,
      expectedUsername: "imap-user@example.com",
      expectedPassword: imapSecret,
      folders: [
        { path: "INBOX", delimiter: "/", flags: ["\\HasNoChildren"], uidValidity: 101, uidNext: 1, messages: [] },
        { path: "Archive", delimiter: "/", flags: ["\\HasNoChildren", "\\Archive"], uidValidity: 201, uidNext: 1, messages: [] },
        { path: "Spam", delimiter: "/", flags: ["\\HasNoChildren", "\\Junk"], uidValidity: 301, uidNext: 1, messages: [] },
        { path: "Trash", delimiter: "/", flags: ["\\HasNoChildren", "\\Trash"], uidValidity: 401, uidNext: 1, messages: [] },
        { path: "Projects", delimiter: "/", flags: ["\\HasNoChildren"], uidValidity: 501, uidNext: 1, messages: [] },
      ],
    });

    imapServer.appendMessage("INBOX", {
      uid: 1,
      flags: [],
      subject: "Deploy Notice",
      fromName: "Ops",
      fromAddress: "ops@example.com",
      messageId: "<deploy-1@example.com>",
      rawRfc822: [
        "Subject: Deploy Notice",
        "From: Ops <ops@example.com>",
        "Message-ID: <deploy-1@example.com>",
        'Content-Type: text/html; charset="utf-8"',
        "",
        "<div>Deploy succeeded. OTP <b>731905</b><script>alert(1)</script></div>",
      ].join("\r\n"),
    });
    imapServer.appendMessage("INBOX", {
      uid: 2,
      flags: ["\\Seen"],
      subject: "Quarterly Summary",
      fromName: "Finance",
      fromAddress: "finance@example.com",
      messageId: "<summary-2@example.com>",
      rawRfc822: [
        "Subject: Quarterly Summary",
        "From: Finance <finance@example.com>",
        "Message-ID: <summary-2@example.com>",
        'Content-Type: text/plain; charset="utf-8"',
        "",
        "Offline test body content.",
      ].join("\r\n"),
    });

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
    const resolvedUseCases: string[] = [];
    const imapTransport = new ImapFlowTransport({
      connectionTimeoutMs: 5_000,
      ca: certPem,
    });

    const runtime = await startEasyEmailServiceRuntime({
      sendQueueWorkerEnabled: false,
      config: baseConfig,
      mailImapTransport: imapTransport,
      mailImapConnectionTester: imapTransport,
      mailCredentialResolver: {
        async resolveCredential(request) {
          resolvedUseCases.push(request.useCase);
          return { status: "resolved", secret: imapSecret };
        },
      },
    });

    const headers = {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    };

    try {
      // Unauthenticated check
      const unauthRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/acct_missing/sync`);
      expect(unauthRes.status).toBe(401);

      // Create normal IMAP account
      const accountRes = await fetch(`${runtime.server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "Ops Mailbox",
          primaryAddress: "imap-user@example.com",
          imap: {
            host: "127.0.0.1",
            port: imapServer.port,
            security: "tls",
            username: "imap-user@example.com",
          },
          credentialRefs: [
            {
              secretBackend: "windows_credential_manager",
              secretKey: "ref:v1:desktop/00000000000000000000000000000061",
              credentialKind: "imap_password",
              authMethod: "password",
            },
          ],
        }),
      });
      expect(accountRes.status).toBe(200);
      const { account } = (await accountRes.json()) as { account: { id: string } };

      // Before sync: honest never_synced status
      const preSyncStatusRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/sync`, { headers });
      expect(preSyncStatusRes.status).toBe(200);
      const preSyncBody = (await preSyncStatusRes.json()) as {
        status: { syncState: string; isStale: boolean; folderCount: number };
      };
      expect(preSyncBody.status).toMatchObject({
        syncState: "never_synced",
        isStale: true,
        folderCount: 0,
      });

      // Trigger sync over HTTP
      const syncRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({ limit: 25 }),
      });
      expect(syncRes.status).toBe(200);
      const syncPayload = (await syncRes.json()) as {
        sync: {
          fetchedCount: number;
          insertedCount: number;
          folders: Array<{ path: string; folderKind: string }>;
        };
        status: { syncState: string; isStale: boolean; folderCount: number };
      };
      expect(syncPayload.sync.fetchedCount).toBe(2);
      expect(syncPayload.sync.insertedCount).toBe(2);
      expect(syncPayload.status).toMatchObject({
        syncState: "synced",
        isStale: false,
        folderCount: 5,
      });
      expect(resolvedUseCases).toContain("imap-sync");

      // List discovered folders
      const foldersRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/folders`, { headers });
      expect(foldersRes.status).toBe(200);
      const foldersPayload = (await foldersRes.json()) as {
        folders: Array<{ path: string; folderKind: string }>;
      };
      expect(foldersPayload.folders.map((f) => f.path)).toContain("Projects");

      // List synced messages (headers cached, bodyCacheState === "none" initially)
      const listRes = await fetch(`${runtime.server.baseUrl}/mail/messages?accountId=${account.id}&folder=inbox`, {
        headers,
      });
      expect(listRes.status).toBe(200);
      const listPayload = (await listRes.json()) as {
        messages: Array<{ id: string; subject: string; isRead: boolean }>;
      };
      expect(listPayload.messages).toHaveLength(2);
      const deployMsg = listPayload.messages.find((m) => m.subject === "Deploy Notice")!;
      const summaryMsg = listPayload.messages.find((m) => m.subject === "Quarterly Summary")!;
      expect(deployMsg.isRead).toBe(false);
      expect(summaryMsg.isRead).toBe(true);

      // Lazy body hydration on GET /mail/messages/{id}: sanitizes <script> and extracts OTP!
      const detailRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${deployMsg.id}`, { headers });
      expect(detailRes.status).toBe(200);
      const detailPayload = (await detailRes.json()) as {
        message: { bodyCacheState: string; bodyHtml?: string };
      };
      expect(detailPayload.message.bodyCacheState).toBe("cached");
      expect(detailPayload.message.bodyHtml).toContain("731905");
      expect(detailPayload.message.bodyHtml).not.toContain("<script>");

      const verificationsRes = await fetch(`${runtime.server.baseUrl}/mail/verifications`, { headers });
      const verificationsPayload = (await verificationsRes.json()) as {
        verifications: Array<{ code: string; messageId?: string }>;
      };
      expect(verificationsPayload.verifications.some((r) => r.code === "731905" && r.messageId === deployMsg.id)).toBe(true);

      // UIDVALIDITY change + folder rename: re-sync must NOT duplicate deploy-1 or summary-2
      imapServer.renameFolder("Projects", "WorkProjects", 502);
      imapServer.resetUidValidity("INBOX", 102, [
        {
          uid: 101,
          flags: ["\\Seen"],
          subject: "Deploy Notice",
          fromName: "Ops",
          fromAddress: "ops@example.com",
          messageId: "<deploy-1@example.com>",
          rawRfc822: "Subject: Deploy Notice\r\nFrom: Ops <ops@example.com>\r\nMessage-ID: <deploy-1@example.com>\r\n\r\nUpdated UID",
        },
        {
          uid: 102,
          flags: ["\\Seen"],
          subject: "Quarterly Summary",
          fromName: "Finance",
          fromAddress: "finance@example.com",
          messageId: "<summary-2@example.com>",
          rawRfc822: "Subject: Quarterly Summary\r\nFrom: Finance <finance@example.com>\r\nMessage-ID: <summary-2@example.com>\r\n\r\nOffline test body content.",
        },
      ]);

      const resyncRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(resyncRes.status).toBe(200);
      const afterResyncListRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages?accountId=${account.id}&folder=inbox`,
        { headers },
      );
      const afterResyncList = (await afterResyncListRes.json()) as {
        messages: Array<{ id: string; subject: string; isRead: boolean }>;
      };
      expect(afterResyncList.messages).toHaveLength(2);

      const renamedFoldersRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/folders`, { headers });
      const renamedFolders = (await renamedFoldersRes.json()) as { folders: Array<{ path: string }> };
      expect(renamedFolders.folders.map((f) => f.path)).toContain("WorkProjects");
      expect(renamedFolders.folders.map((f) => f.path)).not.toContain("Projects");

      // Remote flag action: star deployMsg -> mutates remote IMAP and sets remoteApplied: true
      const starRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${deployMsg.id}/flags`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ flagName: "starred", enabled: true }),
      });
      expect(starRes.status).toBe(200);
      expect(await starRes.json()).toMatchObject({ action: { messageId: deployMsg.id, remoteApplied: true } });
      expect(imapServer.getFolder("INBOX")?.messages.find((m) => m.uid === 101)?.flags).toContain("\\Flagged");
      expect(resolvedUseCases).toContain("imap-action");

      // Remote folder move to custom folder WorkProjects
      const moveRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${deployMsg.id}/folder`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ folderName: "WorkProjects" }),
      });
      expect(moveRes.status).toBe(200);
      expect(await moveRes.json()).toMatchObject({ action: { messageId: deployMsg.id, remoteApplied: true } });
      expect(imapServer.getFolder("WorkProjects")?.messages).toHaveLength(1);

      // Simulate offline / remote IMAP outage: remote actions MUST fail closed without mutating SQLite!
      imapServer.setFailureMode("drop_connection");

      const failedFlagRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${summaryMsg.id}/flags`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ flagName: "starred", enabled: true }),
      });
      expect(failedFlagRes.status).toBe(503);
      expect(await failedFlagRes.json()).toMatchObject({ code: "IMAP_UNAVAILABLE" });

      // Verify local SQLite state was NOT mutated when remote action failed
      const summaryAfterFailedStarRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${summaryMsg.id}`, {
        headers,
      });
      expect(summaryAfterFailedStarRes.status).toBe(200);
      const summaryAfterFailedStar = (await summaryAfterFailedStarRes.json()) as {
        message: { isStarred: boolean; bodyCacheState: string; snippet: string };
      };
      expect(summaryAfterFailedStar.message.isStarred).toBe(false);
      // Uncached body degrades gracefully to cached header/snippet while offline!
      expect(summaryAfterFailedStar.message.bodyCacheState).toBe("none");
      expect(summaryAfterFailedStar.message.snippet).toContain("Quarterly Summary");

      // Offline sync fails with 503 and marks sync status as error + stale while preserving offline folders/messages
      const failedSyncRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/sync`, {
        method: "POST",
        headers,
        body: JSON.stringify({}),
      });
      expect(failedSyncRes.status).toBe(503);

      const offlineStatusRes = await fetch(`${runtime.server.baseUrl}/mail/accounts/${account.id}/sync`, { headers });
      expect(offlineStatusRes.status).toBe(200);
      const offlineStatus = (await offlineStatusRes.json()) as {
        status: { syncState: string; isStale: boolean; lastErrorCode?: string };
      };
      expect(offlineStatus.status).toMatchObject({
        syncState: "error",
        isStale: true,
        lastErrorCode: "IMAP_UNAVAILABLE",
      });

      // Restore IMAP server and verify delete-to-trash + emptyTrash on remote IMAP
      imapServer.setFailureMode("none");
      const trashRes = await fetch(`${runtime.server.baseUrl}/mail/messages/${summaryMsg.id}/local`, {
        method: "DELETE",
        headers,
      });
      expect(trashRes.status).toBe(200);
      expect(await trashRes.json()).toMatchObject({ action: { messageId: summaryMsg.id, remoteApplied: true } });
      expect(imapServer.getFolder("Trash")?.messages).toHaveLength(1);

      const emptyTrashRes = await fetch(`${runtime.server.baseUrl}/mail/trash`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ messageIds: [summaryMsg.id] }),
      });
      expect(emptyTrashRes.status).toBe(200);
      expect(await emptyTrashRes.json()).toMatchObject({
        result: { changedCount: 1, remoteAppliedCount: 1 },
      });
      expect(imapServer.getFolder("Trash")?.messages).toHaveLength(0);
    } finally {
      await runtime.close();
      await imapServer.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
