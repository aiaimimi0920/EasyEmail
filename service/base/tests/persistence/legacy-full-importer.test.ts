import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { FileMailStateStore } from "../../src/persistence/file-state-store.js";
import {
  importLegacyEasyEmailAmDatabase,
  LEGACY_FULL_IMPORTER_VERSION,
  SqliteRelationalDatabase,
} from "../../src/persistence/relational/database.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { ContactService } from "../../src/service/contacts.js";
import { MailAgentService } from "../../src/service/mail-agent.js";
import { MailAvatarService } from "../../src/service/mail-avatar.js";
import { MailExtensionsService } from "../../src/service/mail-extensions.js";
import { MailMessageService } from "../../src/service/mail-messages.js";
import { MailSendQueueService } from "../../src/service/mail-send-queue.js";
import { MailTaxonomyService } from "../../src/service/mail-taxonomy.js";
import { MailVerificationService } from "../../src/service/mail-verifications.js";
import {
  createLegacyDatabaseAtVersion,
  seedFullV10LegacyData,
} from "./legacy-full-importer-fixture.js";

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

describe("M8 versioned full legacy EasyEmailAM database importer", () => {
  it(
    "imports all v10 domains idempotently, strips secrets, sanitizes SVG cache, transitions sending->delivery_unknown, and verifies sample hashes",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "easy-email-m8-full-import-"));
      const sourcePath = join(root, "easyemailam.sqlite");
      const targetDbPath = join(root, "easy-email-relational.sqlite3");
      const targetStatePath = join(root, "easy-email-state.json");
      const secretCanary = "legacy-m8-never-copy-secret-canary-998877";

      try {
        createLegacyDatabaseAtVersion(sourcePath, 10);
        seedFullV10LegacyData(sourcePath, secretCanary);
        const sourceBeforeSha = sha256File(sourcePath);

        const presentKeys = new Set([
          "secret://imap/acct_work",
          "secret://smtp/acct_work",
          "ref:v1:desktop/11111111222233334444555566667777",
        ]);

        const first = await importLegacyEasyEmailAmDatabase({
          sourceDatabasePath: sourcePath,
          targetDatabasePath: targetDbPath,
          targetStateFilePath: targetStatePath,
          defaultHostId: "easyemail-desktop-m8test",
          vaultExistenceCheck: ({ secretKey }) => (presentKeys.has(secretKey) ? "present" : "missing"),
          now: () => new Date("2026-11-22T12:00:00Z"),
        });

        expect(sha256File(sourcePath)).toBe(sourceBeforeSha);
        expect(first.skippedAnonymousCount).toBe(1);
        expect(first.receipt.importerVersion).toBe(LEGACY_FULL_IMPORTER_VERSION);
        expect(first.receipt.domain).toBe("full_database");
        expect(first.receipt.sourceSchemaVersion).toBe(10);
        expect(first.receipt.reauthRequiredCount).toBe(1);
        expect(first.receipt.queueStatusSummary).toEqual({
          delivery_unknown: 1,
          sent: 1,
        });
        expect(first.receipt.verifiedMessageSamples.length).toBe(4);
        expect(first.receipt.importedCounts).toMatchObject({
          accounts: 4,
          credentialRefs: 4,
          contacts: 1,
          taxonomyItems: 3,
          imapFolders: 1,
          syncCheckpoints: 3,
          messages: 4,
          messageSources: 4,
          verificationCodes: 1,
          newsletterOverrides: 1,
          sendQueueItems: 2,
          agentServices: 1,
          agentThreads: 1,
          agentMessages: 1,
          clientSettings: 1,
          avatarSettings: 1,
          avatarCacheEntries: 2,
          contactAvatarOverrides: 1,
          tempSessions: 2,
        });

        // Secret canary must NEVER appear in target SQLite or state JSON
        expect(readFileSync(targetStatePath, "utf8")).not.toContain(secretCanary);
        expect(readFileSync(targetDbPath).includes(Buffer.from(secretCanary, "utf8"))).toBe(false);

        // Verify temporary sessions via FileMailStateStore
        const stateStore = new FileMailStateStore({ filePath: targetStatePath });
        const seed = await stateStore.loadSeed();
        expect(seed?.sessions?.map((s) => ({
          id: s.id,
          visibility: s.metadata.visibilityState,
          upgradedAccountId: s.metadata.upgradedAccountId ?? null,
        }))).toEqual([
          { id: "tmp_anon_1", visibility: "anonymous", upgradedAccountId: null },
          { id: "tmp_promo_1", visibility: "upgraded", upgradedAccountId: "acct_promoted" },
        ]);

        // Verify imported domains through canonical service/base services
        const db = new SqliteRelationalDatabase({ databasePath: targetDbPath });
        try {
          const accountSvc = new MailAccountService(db);
          const missingAcct = await accountSvc.getAccount("acct_missing_vault");
          expect(missingAcct.authStatus).toBe("reauthorization_required");
          expect(missingAcct.receiveStatus).toBe("auth_failed");

          const contactSvc = new ContactService(db);
          const contacts = await contactSvc.listContacts({});
          expect(contacts.contacts.map((c) => c.emailAddress)).toEqual(["alice@example.com"]);

          const taxonomySvc = new MailTaxonomyService(db);
          const folders = await taxonomySvc.listItems({ kind: "folder" });
          expect(folders.items.map((f) => ({ id: f.id, parentId: f.parentId ?? null }))).toEqual([
            { id: "tax_root", parentId: null },
            { id: "tax_child", parentId: "tax_root" },
          ]);

          const messageSvc = new MailMessageService(db);
          const workDetail = await messageSvc.getMessageDetail("msg_work_1", { includeRawHtml: true });
          expect(workDetail.isStarred).toBe(true);
          expect(workDetail.labels).toEqual(["VIP"]);

          const verifSvc = new MailVerificationService(db, db);
          const verifs = await verifSvc.listVerifications({ scope: "normal" });
          expect(verifs.map((v) => v.code)).toEqual(["849201"]);

          const extSvc = new MailExtensionsService(db, undefined, { accountRepository: db });
          const clientSettings = await extSvc.getEasyEmailSettings();
          expect(clientSettings.serviceUrl).toBe("https://mail.example.com:8443");
          const subs = await db.listNewsletterSubscriptions("acct_work");
          expect(subs[0]?.hidden).toBe(true);

          const queueSvc = new MailSendQueueService(db);
          const interrupted = await queueSvc.getSendQueueItem("sq_sending_1");
          expect(interrupted.status).toBe("delivery_unknown");

          const agentSvc = new MailAgentService(db, accountSvc);
          const threadDetail = await agentSvc.getAgentThreadDetail("athr_1");
          expect(threadDetail.thread.subject).toBe("Run audit");
          expect(threadDetail.messages).toHaveLength(1);

          const avatarSvc = new MailAvatarService(db);
          const avatarCfg = await avatarSvc.getAvatarSettings();
          expect(avatarCfg.remoteEnabled).toBe(false);
          const resolvedAvatars = await avatarSvc.resolveSenderAvatars({
            senders: ["alice@example.com", "x@evil.test"],
          });
          expect(resolvedAvatars[0]?.sourceKind).toBe("contact");
          // Evil <script> SVG cache entry was downgraded to failed with null imageDataUrl
          expect(resolvedAvatars[1]?.imageDataUrl).toBeNull();
        } finally {
          db.close();
        }

        // Idempotent re-run must import 0 duplicates and skip all existing records
        const second = await importLegacyEasyEmailAmDatabase({
          sourceDatabasePath: sourcePath,
          targetDatabasePath: targetDbPath,
          targetStateFilePath: targetStatePath,
          vaultExistenceCheck: ({ secretKey }) => (presentKeys.has(secretKey) ? "present" : "missing"),
          now: () => new Date("2026-11-22T12:05:00Z"),
        });
        expect(second.receipt.importedCounts.accounts).toBe(0);
        expect(second.receipt.importedCounts.messages).toBe(0);
        expect(second.receipt.importedCounts.tempSessions).toBe(0);
        expect(second.receipt.skippedExistingCounts.accounts).toBe(4);
        expect(second.receipt.skippedExistingCounts.messages).toBe(4);
        expect(second.receipt.skippedExistingCounts.tempSessions).toBe(2);
        expect(second.receipt.verifiedMessageSamples).toEqual(first.receipt.verifiedMessageSamples);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "restores pre-existing relational DB and state JSON byte-for-byte on failure",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "easy-email-m8-rollback-"));
      const sourcePath = join(root, "easyemailam.sqlite");
      const targetDbPath = join(root, "easy-email-relational.sqlite3");
      const targetStatePath = join(root, "easy-email-state.json");

      try {
        createLegacyDatabaseAtVersion(sourcePath, 10);
        seedFullV10LegacyData(sourcePath, "rollback-canary");
        const sourceBeforeSha = sha256File(sourcePath);

        const preDb = new SqliteRelationalDatabase({ databasePath: targetDbPath });
        await preDb.createContact({
          id: "cnt_existing",
          displayName: "Pre Existing",
          emailAddress: "pre@example.com",
          now: "2026-11-01T00:00:00.000Z",
        });
        preDb.close();
        writeFileSync(
          targetStatePath,
          JSON.stringify({ sessions: [{ id: "sess_existing", emailAddress: "keep@example.com" }] }),
          "utf8",
        );
        const stateBeforeSha = sha256File(targetStatePath);

        await expect(
          importLegacyEasyEmailAmDatabase({
            sourceDatabasePath: sourcePath,
            targetDatabasePath: targetDbPath,
            targetStateFilePath: targetStatePath,
            beforeCommitHook: () => {
              throw new Error("SIMULATED_M8_COMMIT_CRASH");
            },
          }),
        ).rejects.toThrow("SIMULATED_M8_COMMIT_CRASH");

        expect(sha256File(sourcePath)).toBe(sourceBeforeSha);
        expect(sha256File(targetStatePath)).toBe(stateBeforeSha);

        const verifyDb = new SqliteRelationalDatabase({ databasePath: targetDbPath });
        try {
          const contacts = await verifyDb.listContacts({ limit: 20 });
          expect(contacts.contacts.map((c) => c.id)).toEqual(["cnt_existing"]);
          const accounts = await verifyDb.listMailAccounts({ scope: "normal", limit: 20 });
          expect(accounts.accounts.map((a) => a.id)).toEqual(["acct_anonymous_virtual"]);
        } finally {
          verifyDb.close();
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );

  it(
    "supports older release upgrade fixtures (schema v1 foundation-only and schema v7 pre-parent_id)",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "easy-email-m8-old-versions-"));
      const v1Source = join(root, "v1-easyemailam.sqlite");
      const v1Target = join(root, "v1-relational.sqlite3");
      const v7Source = join(root, "v7-easyemailam.sqlite");
      const v7Target = join(root, "v7-relational.sqlite3");

      try {
        createLegacyDatabaseAtVersion(v1Source, 1);
        const dbV1 = new DatabaseSync(v1Source);
        dbV1.prepare(`
          INSERT INTO accounts VALUES
          ('acct_v1_user', 'normal', 'normal_long_lived', 'V1 User', 'v1@example.com', 'Manual IMAP',
           'ready', 'not_required', 'disabled', 'disabled', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', NULL)
        `).run();
        dbV1.close();

        const v1Result = await importLegacyEasyEmailAmDatabase({
          sourceDatabasePath: v1Source,
          targetDatabasePath: v1Target,
        });
        expect(v1Result.receipt.sourceSchemaVersion).toBe(1);
        expect(v1Result.receipt.importedCounts.accounts).toBe(1);

        createLegacyDatabaseAtVersion(v7Source, 7);
        const dbV7 = new DatabaseSync(v7Source);
        dbV7.prepare(`
          INSERT INTO mail_taxonomy_items (
            id, kind, name, normalized_name, color, sort_order, system, created_at, updated_at
          ) VALUES ('lbl_v7', 'label', 'Receipts', 'receipts', '#d9ff38', 1, 0, '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z')
        `).run();
        dbV7.close();

        const v7Result = await importLegacyEasyEmailAmDatabase({
          sourceDatabasePath: v7Source,
          targetDatabasePath: v7Target,
        });
        expect(v7Result.receipt.sourceSchemaVersion).toBe(7);
        expect(v7Result.receipt.importedCounts.taxonomyItems).toBe(1);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
