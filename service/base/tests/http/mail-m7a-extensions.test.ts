import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadEasyEmailServiceRuntimeConfigFromEnvironment } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

const API_KEY = "m7a-ext-test-api-key-0123456789abcdef";
const AUTH = { authorization: `Bearer ${API_KEY}` };
const JSON_AUTH = { ...AUTH, "content-type": "application/json" };

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

describe("M7A taxonomy propagation, newsletter subscriptions, and EasyEmail settings over HTTP", () => {
  it("propagates taxonomy renames/deletes to messages, groups newsletter subscriptions, and validates EasyEmail client settings", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-m7a-extensions-"));
    const configPath = await writeTestRuntimeConfig(root);

    const fakeRemoteCatalog = createServer((req, res) => {
      if (req.url === "/mail/catalog") {
        if (req.headers.authorization === "Bearer bad-token") {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "UNAUTHORIZED" }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            catalog: { providerTypes: [{ key: "mailtm" }, { key: "duckmail" }] },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => fakeRemoteCatalog.listen(0, "127.0.0.1", resolve));
    const remotePort = (fakeRemoteCatalog.address() as { port: number }).port;
    const remoteUrl = `http://127.0.0.1:${remotePort}`;

    const config = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: root,
    });

    const runtime = await startEasyEmailServiceRuntime({
      config,
      sendQueueWorkerEnabled: false,
    });

    try {
      const createAcctRes = await fetch(`${runtime.server.baseUrl}/mail/accounts`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({
          kind: "normal_long_lived",
          displayName: "Reader Account",
          primaryAddress: "reader@example.com",
          providerLabel: "Custom",
        }),
      });
      expect(createAcctRes.status).toBe(200);
      const { account } = (await createAcctRes.json()) as { account: { id: string } };

      const msg1 = await runtime.mailMessageRepository!.ingestMailMessage({
        accountId: account.id,
        sourceKind: "imap",
        sourceRefId: "imap:nl:1",
        receivedAddress: "reader@example.com",
        providerLabel: "Custom",
        lifecycleState: "ready",
        fromName: "Tech Weekly",
        fromAddress: "digest@techweekly.example",
        subject: "Issue #41",
        snippet: "Top stories this week.",
        bodyText: "Top stories this week. Unsubscribe anytime.",
        classification: "newsletter",
        newsletterListId: "<weekly.techweekly.example>",
        newsletterUnsubscribeMethods: [
          "https://techweekly.example/unsub?id=41",
          "mailto:unsub@techweekly.example",
        ],
        observedAt: "2026-09-05T09:00:00.000Z",
        now: "2026-09-05T09:00:00.000Z",
      });
      const msg2 = await runtime.mailMessageRepository!.ingestMailMessage({
        accountId: account.id,
        sourceKind: "imap",
        sourceRefId: "imap:nl:2",
        receivedAddress: "reader@example.com",
        providerLabel: "Custom",
        lifecycleState: "ready",
        fromName: "Tech Weekly",
        fromAddress: "digest@techweekly.example",
        subject: "Issue #42",
        snippet: "Latest updates.",
        bodyText: "Latest updates.",
        classification: "newsletter",
        newsletterListId: "weekly.techweekly.example",
        newsletterUnsubscribeMethods: ["https://techweekly.example/unsub?id=42"],
        observedAt: "2026-09-05T10:00:00.000Z",
        now: "2026-09-05T10:00:00.000Z",
      });

      await fetch(`${runtime.server.baseUrl}/mail/messages/${msg2.messageId}/flags`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ flagName: "read", enabled: true }),
      });

      const folderUpsert = await fetch(`${runtime.server.baseUrl}/mail/taxonomy/folder/receipts`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify({ name: "Receipts" }),
      });
      const { item: folderItem, capabilities } = (await folderUpsert.json()) as {
        item: { id: string; version: number };
        capabilities: { messageReferencePropagation: boolean };
      };
      expect(capabilities.messageReferencePropagation).toBe(true);

      const labelUpsert = await fetch(`${runtime.server.baseUrl}/mail/taxonomy/label/vip`, {
        method: "PUT",
        headers: JSON_AUTH,
        body: JSON.stringify({ name: "VIP" }),
      });
      const { item: labelItem } = (await labelUpsert.json()) as {
        item: { id: string; version: number };
      };

      await fetch(`${runtime.server.baseUrl}/mail/messages/${msg1.messageId}/folder`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ folderName: "receipts" }),
      });
      await fetch(`${runtime.server.baseUrl}/mail/messages/${msg1.messageId}/labels`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ labelName: "vip", enabled: true }),
      });

      await fetch(`${runtime.server.baseUrl}/mail/taxonomy/${folderItem.id}`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ expectedVersion: folderItem.version, name: "Invoices" }),
      });
      await fetch(`${runtime.server.baseUrl}/mail/taxonomy/${labelItem.id}`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ expectedVersion: labelItem.version, name: "Priority" }),
      });

      const detailAfterRenameRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages/${msg1.messageId}`,
        { headers: AUTH },
      );
      const { message: detailAfterRename } = (await detailAfterRenameRes.json()) as {
        message: {
          localFolder: string;
          labels: string[];
          newsletterSubscriptionId?: string;
        };
      };
      expect(detailAfterRename.localFolder).toBe("invoices");
      expect(detailAfterRename.labels).toEqual(["newsletters", "Priority"]);
      expect(detailAfterRename.newsletterSubscriptionId).toBe("list:weekly.techweekly.example");

      await fetch(`${runtime.server.baseUrl}/mail/taxonomy/${folderItem.id}?expectedVersion=2`, {
        method: "DELETE",
        headers: AUTH,
      });
      await fetch(`${runtime.server.baseUrl}/mail/taxonomy/${labelItem.id}?expectedVersion=2`, {
        method: "DELETE",
        headers: AUTH,
      });

      const detailAfterDeleteRes = await fetch(
        `${runtime.server.baseUrl}/mail/messages/${msg1.messageId}`,
        { headers: AUTH },
      );
      const { message: detailAfterDelete } = (await detailAfterDeleteRes.json()) as {
        message: { localFolder: string; labels: string[] };
      };
      expect(detailAfterDelete.localFolder).toBe("inbox");
      expect(detailAfterDelete.labels).toEqual(["newsletters"]);

      const listSubsRes = await fetch(
        `${runtime.server.baseUrl}/mail/newsletters/subscriptions?accountId=${encodeURIComponent(account.id)}`,
        { headers: AUTH },
      );
      expect(listSubsRes.status).toBe(200);
      const { subscriptions } = (await listSubsRes.json()) as {
        subscriptions: Array<{
          id: string;
          listId: string;
          name: string;
          receivedMessageCount: number;
          unreadMessageCount: number;
          unsubscribeMethods: string[];
          hidden: boolean;
        }>;
      };
      expect(subscriptions).toHaveLength(1);
      expect(subscriptions[0]).toMatchObject({
        id: "list:weekly.techweekly.example",
        listId: "weekly.techweekly.example",
        name: "Tech Weekly",
        receivedMessageCount: 2,
        unreadMessageCount: 1,
        hidden: false,
      });
      expect(subscriptions[0]?.unsubscribeMethods).toContain(
        "https://techweekly.example/unsub?id=42",
      );

      const hideRes = await fetch(
        `${runtime.server.baseUrl}/mail/newsletters/subscriptions/${encodeURIComponent("list:weekly.techweekly.example")}`,
        {
          method: "PATCH",
          headers: JSON_AUTH,
          body: JSON.stringify({ accountId: account.id, hidden: true }),
        },
      );
      expect(hideRes.status).toBe(200);
      expect(await hideRes.json()).toMatchObject({
        action: {
          accountId: account.id,
          subscriptionId: "list:weekly.techweekly.example",
          hidden: true,
          changed: true,
        },
      });

      const listSubsAfterHide = await fetch(
        `${runtime.server.baseUrl}/mail/newsletters/subscriptions?accountId=${encodeURIComponent(account.id)}`,
        { headers: AUTH },
      );
      const { subscriptions: hiddenSubs } = (await listSubsAfterHide.json()) as {
        subscriptions: Array<{ hidden: boolean }>;
      };
      expect(hiddenSubs[0]?.hidden).toBe(true);

      const initialSettingsRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail`, {
        headers: AUTH,
      });
      expect(initialSettingsRes.status).toBe(200);
      expect(await initialSettingsRes.json()).toEqual({
        settings: { serviceUrl: null, hasApiToken: true },
      });

      const forbiddenSecretRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ serviceUrl: remoteUrl, apiToken: "secret" }),
      });
      expect(forbiddenSecretRes.status).toBe(400);
      expect(await forbiddenSecretRes.json()).toMatchObject({
        code: "SETTINGS_SECRET_FORBIDDEN",
      });

      const invalidUrlRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ serviceUrl: "ftp://invalid.example" }),
      });
      expect(invalidUrlRes.status).toBe(400);

      const updateSettingsRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail`, {
        method: "PATCH",
        headers: JSON_AUTH,
        body: JSON.stringify({ serviceUrl: `${remoteUrl}/` }),
      });
      expect(updateSettingsRes.status).toBe(200);
      expect(await updateSettingsRes.json()).toEqual({
        settings: { serviceUrl: remoteUrl, hasApiToken: false },
      });

      const testOkRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ apiToken: "good-token" }),
      });
      expect(testOkRes.status).toBe(200);
      expect(await testOkRes.json()).toEqual({
        health: {
          reachable: true,
          providerCount: 2,
          authStatus: "authenticated",
          capabilitiesSummary: "temporary mail and verification",
        },
      });

      const testBadAuthRes = await fetch(`${runtime.server.baseUrl}/mail/settings/easyemail/test`, {
        method: "POST",
        headers: JSON_AUTH,
        body: JSON.stringify({ apiToken: "bad-token" }),
      });
      expect(testBadAuthRes.status).toBe(422);
      expect(await testBadAuthRes.json()).toMatchObject({ code: "EASYEMAIL_AUTH_FAILED" });
    } finally {
      await runtime.close();
      await new Promise<void>((resolve) => fakeRemoteCatalog.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });
});
