import assert from "node:assert/strict";
import test from "node:test";

import {
  createMailAccountClient,
  formatAccountSyncBadge,
  type MailAccountHttpTransport,
} from "../src/api/mailAccountClient.ts";
import type { DesktopCredentialTransport } from "../src/api/desktopCredentialClient.ts";

const noopCredentials: DesktopCredentialTransport = {
  async storeImapPassword() {
    throw new Error("not used");
  },
  async storeSmtpPassword() {
    throw new Error("not used");
  },
  async deleteCredential() {},
};

function baseTransport(
  overrides: Partial<MailAccountHttpTransport> = {},
): MailAccountHttpTransport {
  return {
    async listMailAccounts() {
      return { accounts: [] };
    },
    async createMailAccount() {
      throw new Error("not used");
    },
    async disableMailAccount() {
      throw new Error("not used");
    },
    async deleteMailAccount() {
      throw new Error("not used");
    },
    async testMailAccountImap() {
      throw new Error("not used");
    },
    async testMailAccountSmtp() {
      throw new Error("not used");
    },
    ...overrides,
  };
}

test("formatAccountSyncBadge distinguishes never_synced, synced, stale, error, and auth_failed honestly", () => {
  assert.equal(formatAccountSyncBadge(undefined), "未同步");
  assert.equal(
    formatAccountSyncBadge({
      account_id: "acct_1",
      sync_state: "never_synced",
      is_stale: true,
      stale_after_ms: 900_000,
      last_attempt_at: null,
      last_synced_at: null,
      last_fetched_count: 0,
      last_inserted_count: 0,
      last_error_code: null,
      last_error_message: null,
      folder_count: 0,
    }),
    "未同步",
  );
  assert.equal(
    formatAccountSyncBadge({
      account_id: "acct_1",
      sync_state: "synced",
      is_stale: false,
      stale_after_ms: 900_000,
      last_attempt_at: "2026-09-22T00:00:00Z",
      last_synced_at: "2026-09-22T00:00:00Z",
      last_fetched_count: 8,
      last_inserted_count: 3,
      last_error_code: null,
      last_error_message: null,
      folder_count: 4,
    }),
    "已同步",
  );
  assert.equal(
    formatAccountSyncBadge({
      account_id: "acct_1",
      sync_state: "stale",
      is_stale: true,
      stale_after_ms: 900_000,
      last_attempt_at: "2026-09-22T00:00:00Z",
      last_synced_at: "2026-09-22T00:00:00Z",
      last_fetched_count: 8,
      last_inserted_count: 3,
      last_error_code: null,
      last_error_message: null,
      folder_count: 4,
    }),
    "缓存过期",
  );
  assert.equal(
    formatAccountSyncBadge({
      account_id: "acct_1",
      sync_state: "error",
      is_stale: true,
      stale_after_ms: 900_000,
      last_attempt_at: "2026-09-22T00:05:00Z",
      last_synced_at: "2026-09-22T00:00:00Z",
      last_fetched_count: 0,
      last_inserted_count: 0,
      last_error_code: "IMAP_UNAVAILABLE",
      last_error_message: "offline",
      folder_count: 4,
    }),
    "同步失败·缓存",
  );
  assert.equal(
    formatAccountSyncBadge({
      account_id: "acct_1",
      sync_state: "auth_failed",
      is_stale: true,
      stale_after_ms: 900_000,
      last_attempt_at: "2026-09-22T00:05:00Z",
      last_synced_at: null,
      last_fetched_count: 0,
      last_inserted_count: 0,
      last_error_code: "IMAP_AUTH_FAILED",
      last_error_message: "rejected",
      folder_count: 0,
    }),
    "需重认证",
  );
});

test("mailAccountClient maps M6 HTTP folder discovery, sync status, and account sync results", async () => {
  const observedCalls: Array<{ op: string; accountId: string; payload?: unknown }> = [];
  const client = createMailAccountClient(
    baseTransport({
      async listMailAccountFolders(accountId, query) {
        observedCalls.push({ op: "folders", accountId, payload: query });
        return {
          refreshed: true,
          folders: [
            {
              id: "fld_inbox",
              accountId,
              sourceRefId: "src_1",
              providerFolderId: "INBOX",
              displayName: "INBOX",
              path: "INBOX",
              delimiter: "/",
              folderKind: "inbox",
              uidValidity: "101",
              lastSeenUid: "42",
              lastSyncedAt: "2026-09-22T01:00:00Z",
              createdAt: "2026-09-22T00:00:00Z",
              updatedAt: "2026-09-22T01:00:00Z",
            },
          ],
        };
      },
      async getMailAccountSyncStatus(accountId) {
        observedCalls.push({ op: "status", accountId });
        return {
          status: {
            accountId,
            syncState: "synced",
            isStale: false,
            staleAfterMs: 900_000,
            lastAttemptAt: "2026-09-22T01:00:00Z",
            lastSyncedAt: "2026-09-22T01:00:00Z",
            lastFetchedCount: 10,
            lastInsertedCount: 4,
            folderCount: 5,
          },
        };
      },
      async syncMailAccount(accountId, request) {
        observedCalls.push({ op: "sync", accountId, payload: request });
        return {
          sync: {
            accountId,
            primaryFolderId: "fld_inbox",
            fetchedCount: 10,
            insertedCount: 4,
            uidValidityChangedCount: 0,
            folders: [],
            syncedAt: "2026-09-22T01:05:00Z",
          },
          status: {
            accountId,
            syncState: "synced",
            isStale: false,
            staleAfterMs: 900_000,
            lastAttemptAt: "2026-09-22T01:05:00Z",
            lastSyncedAt: "2026-09-22T01:05:00Z",
            lastFetchedCount: 10,
            lastInsertedCount: 4,
            folderCount: 5,
          },
        };
      },
    }),
    noopCredentials,
  );

  const folders = await client.listAccountFolders("acct_v1_99", { refresh: true });
  assert.equal(folders.refreshed, true);
  assert.equal(folders.folders[0]?.folder_kind, "inbox");
  assert.equal(folders.folders[0]?.last_seen_uid, "42");

  const status = await client.getAccountSyncStatus("acct_v1_99");
  assert.equal(status.sync_state, "synced");
  assert.equal(status.is_stale, false);
  assert.equal(status.folder_count, 5);

  const synced = await client.syncAccount("acct_v1_99", { limit: 25 });
  assert.equal(synced.fetched_count, 10);
  assert.equal(synced.inserted_count, 4);
  assert.equal(synced.status.sync_state, "synced");
  assert.deepEqual(observedCalls, [
    { op: "folders", accountId: "acct_v1_99", payload: { refresh: true } },
    { op: "status", accountId: "acct_v1_99" },
    { op: "sync", accountId: "acct_v1_99", payload: { limit: 25 } },
  ]);
});
