import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  restoreRelationalDatabaseBackup,
  SqliteRelationalDatabase,
} from "../../src/persistence/relational/database.js";
import {
  RELATIONAL_MIGRATIONS,
  prepareRelationalMigrations,
  type RelationalMigration,
} from "../../src/persistence/relational/migrations.js";
import { ContactService } from "../../src/service/contacts.js";

const NOW = new Date("2026-09-01T08:00:00.000Z");

describe("relational SQLite persistence", () => {
  it("upgrades a v1 contact database through account schema v3 with a restorable backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-taxonomy-migration-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    try {
      const versionOne = new SqliteRelationalDatabase({
        databasePath,
        migrations: [RELATIONAL_MIGRATIONS[0] as RelationalMigration],
      });
      const contact = await new ContactService(versionOne, () => NOW).createContact({
        displayName: "Before taxonomy",
        emailAddress: "before-taxonomy@example.test",
      });
      versionOne.close();

      const upgraded = new SqliteRelationalDatabase({ databasePath });
      try {
        expect(upgraded.backupPath && existsSync(upgraded.backupPath)).toBe(true);
        await expect(upgraded.getContact(contact.id)).resolves.toMatchObject({ id: contact.id });
        await expect(upgraded.listMailTaxonomyItems({ kind: "folder", limit: 10 }))
          .resolves.toEqual({ items: [], hasMore: false });
        await expect(upgraded.listMailAccounts({ scope: "normal", limit: 10 }))
          .resolves.toMatchObject({
            accounts: [{ id: "acct_anonymous_virtual", scope: "system", kind: "anonymous_virtual" }],
            hasMore: false,
          });
      } finally {
        upgraded.close();
      }

      const inspector = new DatabaseSync(databasePath);
      try {
        expect(inspector.prepare(
          "SELECT version, result FROM schema_migrations ORDER BY version",
        ).all()).toEqual([
          { version: 1, result: "applied" },
          { version: 2, result: "applied" },
          { version: 3, result: "applied" },
        ]);
      } finally {
        inspector.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves contact ordering, pagination, upsert identity, CAS, delete, and restart readback", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-relational-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    let tick = 0;
    const now = () => new Date(NOW.getTime() + tick++ * 1000);

    try {
      const firstDatabase = new SqliteRelationalDatabase({ databasePath });
      const contacts = new ContactService(firstDatabase, now);
      const bob = await contacts.createContact({
        displayName: "  Bob  ",
        emailAddress: "Bob@Example.COM",
        note: "  teammate  ",
      });
      const ada = await contacts.createContact({
        displayName: "Ada",
        emailAddress: "ada@example.com",
      });
      const grace = await contacts.createContact({
        displayName: "Grace",
        emailAddress: "grace@example.com",
      });
      expect(bob).toMatchObject({
        displayName: "Bob",
        emailAddress: "bob@example.com",
        note: "teammate",
        version: 1,
      });

      const firstPage = await contacts.listContacts({ limit: 2 });
      expect(firstPage.contacts.map((contact) => contact.id)).toEqual([ada.id, bob.id]);
      expect(firstPage.nextCursor).toBeTruthy();
      const secondPage = await contacts.listContacts({ limit: 2, cursor: firstPage.nextCursor });
      expect(secondPage.contacts.map((contact) => contact.id)).toEqual([grace.id]);
      expect(secondPage.nextCursor).toBeUndefined();

      const upserted = await contacts.createContact({
        displayName: "Robert",
        emailAddress: "BOB@example.com",
        note: null,
      });
      expect(upserted).toMatchObject({ id: bob.id, displayName: "Robert", version: 2 });
      expect(upserted.createdAt).toBe(bob.createdAt);

      const updated = await contacts.updateContact(bob.id, {
        expectedVersion: 2,
        emailAddress: "robert@example.com",
      });
      expect(updated).toMatchObject({
        id: bob.id,
        emailAddress: "robert@example.com",
        version: 3,
      });
      await expect(contacts.updateContact(bob.id, {
        expectedVersion: 2,
        note: "stale",
      })).rejects.toMatchObject({ code: "CONTACT_VERSION_CONFLICT" });
      await expect(contacts.updateContact(grace.id, {
        expectedVersion: 1,
        emailAddress: "ada@example.com",
      })).rejects.toMatchObject({ code: "CONTACT_EMAIL_CONFLICT" });

      await expect(contacts.deleteContact(bob.id, { expectedVersion: 2 }))
        .rejects.toMatchObject({ code: "CONTACT_VERSION_CONFLICT" });
      await expect(contacts.deleteContact(bob.id, { expectedVersion: 3 }))
        .resolves.toEqual({ id: bob.id });
      firstDatabase.close();

      const restartedDatabase = new SqliteRelationalDatabase({ databasePath });
      try {
        const restartedContacts = new ContactService(restartedDatabase, now);
        const restored = await restartedContacts.listContacts();
        expect(restored.contacts.map((contact) => contact.id)).toEqual([ada.id, grace.id]);
        await expect(restartedContacts.getContact(bob.id))
          .rejects.toMatchObject({ code: "CONTACT_NOT_FOUND" });
      } finally {
        restartedDatabase.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("records checksums, rolls back a failed migration, and leaves a restorable backup", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-migration-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    const base = new SqliteRelationalDatabase({ databasePath });
    await new ContactService(base, () => NOW).createContact({
      displayName: "Before migration",
      emailAddress: "before@example.com",
    });
    base.close();

    const failingMigrations: RelationalMigration[] = [
      ...RELATIONAL_MIGRATIONS,
      {
        version: 4,
        name: "intentional-test-failure",
        sql: "CREATE TABLE should_rollback (id TEXT PRIMARY KEY); SELECT missing_test_function();",
      },
    ];

    try {
      expect(() => new SqliteRelationalDatabase({
        databasePath,
        migrations: failingMigrations,
        now: () => NOW,
      })).toThrow(expect.objectContaining({ code: "RELATIONAL_MIGRATION_FAILED" }));

      const inspector = new DatabaseSync(databasePath);
      try {
        const failed = inspector.prepare(
          "SELECT checksum, result, error_code FROM schema_migrations WHERE version = 4",
        ).get() as { checksum: string; result: string; error_code: string };
        expect(failed).toEqual({
          checksum: prepareRelationalMigrations(failingMigrations)[3]?.checksum,
          result: "failed",
          error_code: "RELATIONAL_MIGRATION_FAILED",
        });
        expect(inspector.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'should_rollback'",
        ).get()).toBeUndefined();
        expect(inspector.prepare("SELECT COUNT(*) AS count FROM contacts").get())
          .toEqual({ count: 1 });
      } finally {
        inspector.close();
      }

      const backups = readdirSync(root).filter((name) => name.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      const backupPath = join(root, backups[0] as string);
      expect(existsSync(backupPath)).toBe(true);

      const current = new DatabaseSync(databasePath);
      current.exec("DELETE FROM contacts");
      current.close();
      const restore = restoreRelationalDatabaseBackup(databasePath, backupPath);
      expect(restore.previousDatabasePath && existsSync(restore.previousDatabasePath)).toBe(true);

      const restored = new SqliteRelationalDatabase({ databasePath });
      try {
        const page = await new ContactService(restored, () => NOW).listContacts();
        expect(page.contacts).toHaveLength(1);
        expect(page.contacts[0]?.emailAddress).toBe("before@example.com");
      } finally {
        restored.close();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when an applied migration checksum changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-checksum-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    try {
      const database = new SqliteRelationalDatabase({ databasePath });
      database.close();
      const inspector = new DatabaseSync(databasePath);
      inspector.prepare("UPDATE schema_migrations SET checksum = 'tampered' WHERE version = 1").run();
      inspector.close();

      expect(() => new SqliteRelationalDatabase({ databasePath }))
        .toThrow(expect.objectContaining({ code: "RELATIONAL_MIGRATION_CHECKSUM_MISMATCH" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects an unsupported newer schema and refuses to restore over an open target", async () => {
    const root = await mkdtemp(join(tmpdir(), "easy-email-newer-schema-"));
    const databasePath = join(root, "easy-email-relational.sqlite3");
    const database = new SqliteRelationalDatabase({ databasePath });
    try {
      const backupPath = join(root, "backup.sqlite3");
      const backup = new DatabaseSync(backupPath);
      backup.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          checksum TEXT NOT NULL,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          result TEXT NOT NULL,
          error_code TEXT
        );
      `);
      backup.close();
      expect(() => restoreRelationalDatabaseBackup(databasePath, backupPath))
        .toThrow(expect.objectContaining({ code: "RELATIONAL_RESTORE_TARGET_OPEN" }));
    } finally {
      database.close();
    }

    const inspector = new DatabaseSync(databasePath);
    inspector.prepare(`
      INSERT INTO schema_migrations (
        version, name, checksum, started_at, finished_at, result, error_code
      ) VALUES (99, 'future', 'future', ?, ?, 'applied', NULL)
    `).run(NOW.toISOString(), NOW.toISOString());
    inspector.close();
    try {
      expect(() => new SqliteRelationalDatabase({ databasePath }))
        .toThrow(expect.objectContaining({ code: "RELATIONAL_SCHEMA_NEWER" }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
