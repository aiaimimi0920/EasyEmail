import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  importLegacyEasyEmailAmAccounts,
  SqliteRelationalDatabase,
} from "../../src/persistence/relational/database.js";
import { MailAccountService } from "../../src/service/accounts.js";

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function createLegacyEasyEmailAmDatabase(filePath: string): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        kind TEXT NOT NULL,
        display_name TEXT NOT NULL,
        primary_address TEXT,
        provider_label TEXT,
        status TEXT NOT NULL,
        auth_status TEXT NOT NULL,
        receive_status TEXT NOT NULL,
        send_status TEXT NOT NULL,
        listed_in_all_accounts INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE mailbox_sources (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        source_kind TEXT NOT NULL,
        address TEXT,
        provider_id TEXT,
        config_json TEXT NOT NULL DEFAULT '{}',
        credential_ref_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE credential_refs (
        id TEXT PRIMARY KEY,
        owner_account_id TEXT,
        source_id TEXT,
        secret_backend TEXT NOT NULL,
        secret_key TEXT NOT NULL,
        credential_kind TEXT NOT NULL,
        auth_method TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_verified_at TEXT
      );
    `);
    for (let version = 1; version <= 10; version += 1) {
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        version,
        `step-${version}`,
        "2026-06-12T00:00:00.000Z",
      );
    }
  } finally {
    db.close();
  }
}

describe("legacy EasyEmailAM account importer", () => {
  it("imports accounts and opaque refs idempotently, marks missing vault entries for reauth, and leaves source untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-legacy-import-"));
    const sourcePath = join(root, "easyemailam.sqlite");
    const targetPath = join(root, "easy-email-relational.sqlite3");
    try {
      createLegacyEasyEmailAmDatabase(sourcePath);
      const seed = new DatabaseSync(sourcePath);
      try {
        seed.prepare(`
          INSERT INTO accounts VALUES
          ('acct_legacy_anon', 'system', 'anonymous_virtual', 'Anonymous', NULL, NULL,
           'ready', 'not_required', 'enabled', 'unsupported', 1,
           '2026-06-12T00:00:00Z', '2026-06-12T00:00:00Z', NULL),
          ('acct_legacy_work', 'normal', 'normal_long_lived', '  Work Mail  ', 'WORK@Example.COM', 'Manual IMAP',
           'ready', 'valid', 'enabled', 'enabled', 1,
           '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z', NULL),
          ('acct_legacy_missing', 'normal', 'normal_long_lived', 'Missing Vault', 'missing@example.com', 'Manual IMAP',
           'ready', 'valid', 'enabled', 'enabled', 1,
           '2026-06-12T00:02:00Z', '2026-06-12T00:02:00Z', NULL),
          ('acct_legacy_agent', 'agent', 'agent_owned', 'Agent Bot', 'bot@example.com', NULL,
           'configuring', 'missing', 'disabled', 'disabled', 0,
           '2026-06-12T00:03:00Z', '2026-06-12T00:03:00Z', NULL),
          ('acct_legacy_deleted', 'normal', 'normal_long_lived', 'Old Work', 'work@example.com', 'Manual IMAP',
           'deleted', 'missing', 'disabled', 'disabled', 1,
           '2026-06-11T00:00:00Z', '2026-06-11T01:00:00Z', '2026-06-11T02:00:00Z')
        `).run();
        seed.prepare(`
          INSERT INTO mailbox_sources (id, account_id, source_kind, address, provider_id, config_json, status, created_at, updated_at)
          VALUES
          ('src_work_imap', 'acct_legacy_work', 'imap', 'work@example.com', 'imap.example.com',
           '{"host":"IMAP.Example.COM","port":993,"security":"ssl","username":"work@example.com"}',
           'ready', '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z'),
          ('src_missing_imap', 'acct_legacy_missing', 'imap', 'missing@example.com', 'imap.example.com',
           '{"host":"imap.example.com","port":993,"security":"tls","username":"missing@example.com"}',
           'ready', '2026-06-12T00:02:00Z', '2026-06-12T00:02:00Z')
        `).run();
        seed.prepare(`
          INSERT INTO credential_refs VALUES
          ('cred_work_imap', 'acct_legacy_work', 'src_work_imap', 'secret_vault', 'secret://imap/acct_legacy_work',
           'imap_password', 'password', 'active', '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z', '2026-06-12T00:01:05Z'),
          ('cred_work_smtp', 'acct_legacy_work', 'src_work_smtp', 'secret_vault', 'secret://smtp/acct_legacy_work',
           'smtp_password', 'password', 'active', '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z', NULL),
          ('cred_missing_imap', 'acct_legacy_missing', 'src_missing_imap', 'secret_vault', 'secret://imap/acct_legacy_missing',
           'imap_password', 'password', 'active', '2026-06-12T00:02:00Z', '2026-06-12T00:02:00Z', NULL)
        `).run();
      } finally {
        seed.close();
      }

      const sourceBeforeSha = sha256File(sourcePath);
      const vaultSecrets = new Map<string, string>([
        ["secret://imap/acct_legacy_work", "legacy-vault-canary-secret"],
        ["secret://smtp/acct_legacy_work", "legacy-smtp-canary-secret"],
      ]);

      const firstImport = await importLegacyEasyEmailAmAccounts({
        sourceDatabasePath: sourcePath,
        targetDatabasePath: targetPath,
        vaultExistenceCheck: ({ secretKey }) => (vaultSecrets.has(secretKey) ? "present" : "missing"),
        now: () => new Date("2026-09-05T00:00:00Z"),
      });

      expect(sha256File(sourcePath)).toBe(sourceBeforeSha);
      expect(existsSync(firstImport.sourceBackupDirectory)).toBe(true);
      expect(firstImport.skippedAnonymousCount).toBe(1);
      expect(firstImport.receipt).toMatchObject({
        domain: "accounts",
        sourceSha256: sourceBeforeSha,
        sourceSchemaVersion: 10,
        sourceAccountCount: 5,
        sourceCredentialRefCount: 3,
        importedAccountCount: 4,
        skippedExistingCount: 0,
        reauthRequiredCount: 1,
      });

      const database = new SqliteRelationalDatabase({ databasePath: targetPath });
      try {
        const service = new MailAccountService(database, undefined, {
          credentialResolver: {
            async resolveCredential({ credentialRef }) {
              const secret = vaultSecrets.get(credentialRef.secretKey);
              return secret ? { status: "resolved", secret } : { status: "missing" };
            },
          },
          imapTester: {
            async testConnection(profile, secret) {
              expect(profile).toEqual({
                protocol: "imap",
                host: "imap.example.com",
                port: 993,
                security: "tls",
                username: "work@example.com",
              });
              expect(secret).toBe("legacy-vault-canary-secret");
              return { authenticated: true, capabilitySummary: "IMAP4rev1 IDLE" };
            },
          },
        });

        const normalList = await service.listAccounts({ scope: "normal" });
        expect(normalList.accounts.map((item) => item.id)).toEqual([
          "acct_legacy_work",
          "acct_legacy_missing",
          "acct_anonymous_virtual",
        ]);
        const work = await service.getAccount("acct_legacy_work");
        expect(work).toMatchObject({
          displayName: "Work Mail",
          primaryAddress: "work@example.com",
          authStatus: "valid",
          receiveStatus: "enabled",
          imap: { host: "imap.example.com", port: 993, security: "tls", username: "work@example.com" },
        });
        expect(work.credentialRefs.map((ref) => ({ key: ref.secretKey, status: ref.status }))).toEqual([
          { key: "secret://imap/acct_legacy_work", status: "active" },
          { key: "secret://smtp/acct_legacy_work", status: "active" },
        ]);

        const missing = await service.getAccount("acct_legacy_missing");
        expect(missing).toMatchObject({
          authStatus: "reauthorization_required",
          receiveStatus: "auth_failed",
          sendStatus: "enabled",
          credentialRefs: [{ secretKey: "secret://imap/acct_legacy_missing", status: "missing" }],
        });

        await expect(service.testImapConnection({
          accountId: "acct_legacy_work",
          credentialRefId: "cred_work_imap",
        })).resolves.toEqual({ authenticated: true, capabilitySummary: "IMAP4rev1 IDLE" });

        await expect(service.testImapConnection({
          accountId: "acct_legacy_missing",
          credentialRefId: "cred_missing_imap",
        })).rejects.toMatchObject({ code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });

        await service.updateAccount("acct_legacy_work", {
          expectedVersion: 1,
          displayName: "Updated Canonical Work",
        });

        await expect(importLegacyEasyEmailAmAccounts({
          sourceDatabasePath: sourcePath,
          targetDatabasePath: targetPath,
        })).rejects.toMatchObject({ code: "LEGACY_IMPORT_TARGET_OPEN" });
      } finally {
        database.close();
      }

      const secondImport = await importLegacyEasyEmailAmAccounts({
        sourceDatabasePath: sourcePath,
        targetDatabasePath: targetPath,
        vaultExistenceCheck: ({ secretKey }) => (vaultSecrets.has(secretKey) ? "present" : "missing"),
        now: () => new Date("2026-09-05T01:00:00Z"),
      });
      expect(secondImport.receipt).toMatchObject({
        importedAccountCount: 0,
        skippedExistingCount: 4,
        reauthRequiredCount: 0,
      });

      const verifyAfterRerun = new SqliteRelationalDatabase({ databasePath: targetPath });
      try {
        const service = new MailAccountService(verifyAfterRerun);
        await expect(service.getAccount("acct_legacy_work")).resolves.toMatchObject({
          displayName: "Updated Canonical Work",
          version: 2,
        });
      } finally {
        verifyAfterRerun.close();
      }
      expect(readFileSync(targetPath).includes(Buffer.from("legacy-vault-canary-secret", "utf8"))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("restores pre-import target backup on failure and rejects secret-bearing or non-opaque legacy rows", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-legacy-rollback-"));
    const sourcePath = join(root, "easyemailam.sqlite");
    const targetPath = join(root, "easy-email-relational.sqlite3");
    try {
      createLegacyEasyEmailAmDatabase(sourcePath);
      const preExistingDb = new SqliteRelationalDatabase({
        databasePath: targetPath,
        now: () => new Date("2026-09-04T00:00:00Z"),
      });
      const preExistingService = new MailAccountService(preExistingDb, () => new Date("2026-09-04T00:00:00Z"));
      const canonical = await preExistingService.createAccount({
        kind: "normal_long_lived",
        displayName: "Canonical Existing",
        primaryAddress: "existing@example.com",
      });
      preExistingDb.close();

      const seed = new DatabaseSync(sourcePath);
      try {
        seed.prepare(`
          INSERT INTO accounts VALUES
          ('acct_legacy_rollback', 'normal', 'normal_long_lived', 'Rollback Candidate', 'rollback@example.com', NULL,
           'ready', 'valid', 'enabled', 'disabled', 1,
           '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z', NULL)
        `).run();
      } finally {
        seed.close();
      }
      const sourceSha = sha256File(sourcePath);

      await expect(importLegacyEasyEmailAmAccounts({
        sourceDatabasePath: sourcePath,
        targetDatabasePath: targetPath,
        beforeCommitHook: () => {
          throw new Error("simulated pre-commit failure");
        },
      })).rejects.toThrow("simulated pre-commit failure");

      expect(sha256File(sourcePath)).toBe(sourceSha);
      const restored = new SqliteRelationalDatabase({ databasePath: targetPath });
      try {
        const service = new MailAccountService(restored);
        await expect(service.getAccount(canonical.id)).resolves.toMatchObject({
          displayName: "Canonical Existing",
        });
        await expect(service.getAccount("acct_legacy_rollback"))
          .rejects.toMatchObject({ code: "ACCOUNT_NOT_FOUND" });
      } finally {
        restored.close();
      }

      const badRefDb = new DatabaseSync(sourcePath);
      try {
        badRefDb.prepare(`
          INSERT INTO credential_refs VALUES
          ('cred_bad', 'acct_legacy_rollback', NULL, 'secret_vault', 'plaintext-password-value',
           'imap_password', 'password', 'active', '2026-06-12T00:01:00Z', '2026-06-12T00:01:00Z', NULL)
        `).run();
      } finally {
        badRefDb.close();
      }
      await expect(importLegacyEasyEmailAmAccounts({
        sourceDatabasePath: sourcePath,
        targetDatabasePath: targetPath,
      })).rejects.toMatchObject({ code: "LEGACY_IMPORT_CREDENTIAL_REF_INVALID" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
