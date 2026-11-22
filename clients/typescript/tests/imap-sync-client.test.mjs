import assert from "node:assert/strict";
import test from "node:test";

import { EasyEmailClient } from "../dist/index.js";

test("M6 IMAP folder discovery, sync status, and account sync SDK methods use canonical HTTP routes", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:18082",
    apiKey: "sdk-m6-token",
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/folders") && init.method === "GET") {
        return new Response(
          JSON.stringify({
            folders: [
              {
                id: "fld-1",
                accountId: "acct/1",
                sourceRefId: "src-1",
                providerFolderId: "INBOX",
                displayName: "INBOX",
                path: "INBOX",
                delimiter: "/",
                folderKind: "inbox",
                createdAt: "2026-09-22T00:00:00.000Z",
                updatedAt: "2026-09-22T00:00:00.000Z",
              },
            ],
            refreshed: true,
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname.endsWith("/sync") && init.method === "GET") {
        return new Response(
          JSON.stringify({
            status: {
              accountId: "acct/1",
              syncState: "synced",
              isStale: false,
              staleAfterMs: 900_000,
              lastFetchedCount: 5,
              lastInsertedCount: 2,
              folderCount: 4,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify({
          sync: {
            accountId: "acct/1",
            primaryFolderId: "fld-1",
            fetchedCount: 5,
            insertedCount: 2,
            uidValidityChangedCount: 0,
            folders: [],
            syncedAt: "2026-09-22T00:05:00.000Z",
          },
          status: {
            accountId: "acct/1",
            syncState: "synced",
            isStale: false,
            staleAfterMs: 900_000,
            lastFetchedCount: 5,
            lastInsertedCount: 2,
            folderCount: 4,
          },
        }),
        { status: 200 },
      );
    },
  });

  const folders = await client.listMailAccountFolders("acct/1", { refresh: true });
  assert.equal(folders.refreshed, true);
  assert.equal(folders.folders[0].path, "INBOX");
  assert.match(calls[0].url, /\/mail\/accounts\/acct%2F1\/folders\?refresh=true$/);

  const status = await client.getMailAccountSyncStatus("acct/1");
  assert.equal(status.syncState, "synced");
  assert.equal(status.isStale, false);
  assert.match(calls[1].url, /\/mail\/accounts\/acct%2F1\/sync$/);

  const synced = await client.syncMailAccount("acct/1", {
    limit: 30,
    folderKinds: ["inbox", "spam"],
  });
  assert.equal(synced.sync.insertedCount, 2);
  assert.equal(synced.status.folderCount, 4);
  assert.deepEqual(JSON.parse(calls[2].body), {
    limit: 30,
    folderKinds: ["inbox", "spam"],
  });
});
