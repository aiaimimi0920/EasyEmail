import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { SqliteRelationalDatabase } from "../../src/persistence/relational/database.js";
import { RELATIONAL_MIGRATIONS } from "../../src/persistence/relational/migrations.js";
import { MailAccountService } from "../../src/service/accounts.js";

describe("mail account relational persistence", () => {
  it("creates schema v4, persists IMAP metadata and opaque refs, paginates, disables, and reads after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-accounts-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    try {
      const firstDatabase = new SqliteRelationalDatabase({
        databasePath,
        now: () => new Date("2026-09-02T00:00:00Z"),
      });
      const accounts = new MailAccountService(firstDatabase, () => new Date("2026-09-02T00:00:00Z"));
      const first = await accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "Work",
        primaryAddress: "work@example.com",
        imap: {
          host: "imap.example.com",
          port: 993,
          security: "tls",
          username: "work@example.com",
        },
        credentialRefs: [{
          secretBackend: "windows_credential_manager",
          secretKey: "ref:v1:work-imap",
          credentialKind: "imap_password",
          authMethod: "password",
        }],
      });
      const second = await accounts.createAccount({
        kind: "agent_owned",
        scope: "agent",
        displayName: "Agent",
        primaryAddress: "agent@example.com",
      });
      const page = await accounts.listAccounts({ scope: "normal", limit: 1 });
      expect(page.accounts.map((item) => item.id)).toEqual(["acct_anonymous_virtual"]);
      expect(page.nextCursor).toBeTruthy();
      const nextPage = await accounts.listAccounts({
        scope: "normal",
        limit: 1,
        cursor: page.nextCursor,
      });
      expect(nextPage.accounts.map((item) => item.id)).toEqual([first.id]);
      expect(nextPage.nextCursor).toBeUndefined();
      await expect(accounts.listAccounts({ scope: "agent", cursor: page.nextCursor }))
        .rejects.toMatchObject({ code: "INVALID_ACCOUNT_CURSOR" });
      expect(first.credentialRefs[0]).toMatchObject({ ownerAccountId: first.id, status: "missing" });
      expect(existsSync(firstDatabase.backupPath ?? "")).toBe(false);

      const disabled = await accounts.disableAccount(second.id, 1);
      expect(disabled).toMatchObject({ status: "disabled", receiveStatus: "disabled" });
      firstDatabase.close();

      const inspector = new DatabaseSync(databasePath);
      try {
        expect(inspector.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
          .toEqual({ version: 4 });
        expect(inspector.prepare("SELECT COUNT(*) AS count FROM mail_account_credential_refs").get())
          .toEqual({ count: 1 });
        expect(inspector.prepare(
          "SELECT COUNT(*) AS count FROM mail_accounts WHERE kind = 'anonymous_virtual' AND deleted_at IS NULL",
        ).get()).toEqual({ count: 1 });
        expect(() => inspector.prepare(
          "UPDATE mail_accounts SET imap_host = 'partial.example.com' WHERE id = 'acct_anonymous_virtual'",
        ).run()).toThrow();
        expect(() => inspector.prepare(
          "UPDATE mail_accounts SET imap_host = '' WHERE id = ?",
        ).run(first.id)).toThrow();
      } finally {
        inspector.close();
      }

      const restartedDatabase = new SqliteRelationalDatabase({ databasePath });
      try {
        const restarted = new MailAccountService(restartedDatabase);
        await expect(restarted.getAccount(first.id)).resolves.toMatchObject({
          id: first.id,
          imap: {
            protocol: "imap",
            host: "imap.example.com",
            port: 993,
            security: "tls",
            username: "work@example.com",
          },
          credentialRefs: [{ secretKey: "ref:v1:work-imap" }],
        });
        await expect(restarted.getAccount(second.id)).resolves.toMatchObject({ status: "disabled" });
        await expect(restarted.deleteAccount(first.id, { expectedVersion: 1 }))
          .resolves.toEqual({ id: first.id });
        await expect(restarted.listAccounts({ scope: "normal" })).resolves.toMatchObject({
          accounts: [{ id: "acct_anonymous_virtual", scope: "system", kind: "anonymous_virtual" }],
        });
        await expect(restarted.disableAccount("acct_anonymous_virtual", 1))
          .rejects.toMatchObject({ code: "ACCOUNT_SYSTEM_MANAGED" });
      } finally {
        restartedDatabase.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("maps address and cross-account credential reference uniqueness conflicts", async () => {
    const database = new SqliteRelationalDatabase({ databasePath: ":memory:" });
    const accounts = new MailAccountService(database);
    try {
      await accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "First",
        primaryAddress: "same@example.com",
        credentialRefs: [{
          secretBackend: "fake-vault",
          secretKey: "ref:v1:shared",
          credentialKind: "imap_password",
          authMethod: "password",
        }],
      });
      await expect(accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "Duplicate address",
        primaryAddress: "SAME@example.com",
      })).rejects.toMatchObject({ code: "ACCOUNT_ADDRESS_CONFLICT" });
      await expect(accounts.createAccount({
        kind: "normal_long_lived",
        displayName: "Duplicate ref",
        primaryAddress: "other@example.com",
        credentialRefs: [{
          secretBackend: "fake-vault",
          secretKey: "ref:v1:shared",
          credentialKind: "smtp_password",
          authMethod: "password",
        }],
      })).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_CONFLICT" });
    } finally {
      database.close();
    }
  });

  it("upgrades an existing schema v3 account without inventing an IMAP profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-accounts-v3-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    try {
      const versionThree = new SqliteRelationalDatabase({
        databasePath,
        migrations: RELATIONAL_MIGRATIONS.slice(0, 3),
      });
      versionThree.close();
      const writer = new DatabaseSync(databasePath);
      try {
        writer.prepare(`
          INSERT INTO mail_accounts (
            id, scope, kind, display_name, primary_address, provider_label,
            status, auth_status, receive_status, send_status,
            listed_in_all_accounts, version, created_at, updated_at, deleted_at
          ) VALUES (?, 'normal', 'normal_long_lived', ?, ?, NULL,
                    'configuring', 'missing', 'disabled', 'disabled',
                    1, 1, ?, ?, NULL)
        `).run(
          "acct_v3_existing",
          "Existing v3 account",
          "existing-v3@example.com",
          "2026-09-02T00:00:00.000Z",
          "2026-09-02T00:00:00.000Z",
        );
      } finally {
        writer.close();
      }

      const upgraded = new SqliteRelationalDatabase({ databasePath });
      try {
        const account = await upgraded.getMailAccount("acct_v3_existing");
        expect(account).toMatchObject({
          id: "acct_v3_existing",
          primaryAddress: "existing-v3@example.com",
        });
        expect(account?.imap).toBeUndefined();
        expect(upgraded.backupPath && existsSync(upgraded.backupPath)).toBe(true);
      } finally {
        upgraded.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
