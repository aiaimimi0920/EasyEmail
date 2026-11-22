import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : null;
}

const dataDir = argument("--data-dir");
const imapPort = Number(argument("--imap-port"));
const imapUsername = argument("--imap-username");
const presentAccountId = argument("--present-account-id");
const presentSecretKey = argument("--present-secret-key");
const missingAccountId = argument("--missing-account-id");
const missingSecretKey = argument("--missing-secret-key");

if (
  !dataDir
  || !Number.isSafeInteger(imapPort)
  || imapPort <= 0
  || !imapUsername
  || !presentAccountId
  || !presentSecretKey
  || !missingAccountId
  || !missingSecretKey
) {
  throw new Error("Missing required arguments for seed-and-import-legacy-accounts.mjs.");
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const importerModuleUrl = pathToFileURL(
  path.resolve(currentDir, "../../../service/base/dist/src/persistence/relational/database.js"),
).href;
const { importLegacyEasyEmailAmDatabase } = await import(importerModuleUrl);

const legacyDbPath = path.join(dataDir, "easyemailam.sqlite");
const nestedRelationalDbPath = path.join(
  dataDir,
  "core",
  "state",
  "state",
  "easy-email-relational.sqlite3",
);
const directRelationalDbPath = path.join(
  dataDir,
  "core",
  "state",
  "easy-email-relational.sqlite3",
);
const relationalDbPath = fs.existsSync(nestedRelationalDbPath)
  ? nestedRelationalDbPath
  : fs.existsSync(directRelationalDbPath)
    ? directRelationalDbPath
    : nestedRelationalDbPath;
const nowIso = "2026-06-12T00:10:00.000Z";
const imapConfigJson = JSON.stringify({
  host: "127.0.0.1",
  port: imapPort,
  security: "ssl",
  username: imapUsername,
});

const legacyDb = new DatabaseSync(legacyDbPath);
try {
  legacyDb.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, display_name TEXT NOT NULL,
      primary_address TEXT, provider_label TEXT, status TEXT NOT NULL, auth_status TEXT NOT NULL,
      receive_status TEXT NOT NULL, send_status TEXT NOT NULL, listed_in_all_accounts INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS mailbox_sources (
      id TEXT PRIMARY KEY, account_id TEXT, source_kind TEXT NOT NULL, address TEXT, provider_id TEXT,
      config_json TEXT NOT NULL DEFAULT '{}', credential_ref_id TEXT, status TEXT NOT NULL,
      last_sync_at TEXT, last_success_at TEXT, last_error_code TEXT, last_error_message TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS credential_refs (
      id TEXT PRIMARY KEY, owner_account_id TEXT, source_id TEXT, secret_backend TEXT NOT NULL,
      secret_key TEXT NOT NULL, credential_kind TEXT NOT NULL, auth_method TEXT NOT NULL,
      status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_verified_at TEXT
    );
  `);
  for (let v = 1; v <= 10; v += 1) {
    legacyDb.prepare(
      "INSERT OR IGNORE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    ).run(v, `step-${v}`, nowIso);
  }
  legacyDb.exec("BEGIN IMMEDIATE");
  legacyDb.prepare(`
    INSERT INTO accounts (
      id, scope, kind, display_name, primary_address, provider_label,
      status, auth_status, receive_status, send_status,
      listed_in_all_accounts, created_at, updated_at, deleted_at
    ) VALUES
    (?, 'normal', 'normal_long_lived', 'Legacy Imported IMAP', 'legacy-work@example.com', 'Manual IMAP',
     'ready', 'valid', 'enabled', 'disabled', 1, ?, ?, NULL),
    (?, 'normal', 'normal_long_lived', 'Legacy Missing Vault', 'legacy-missing@example.com', 'Manual IMAP',
     'ready', 'valid', 'enabled', 'disabled', 1, ?, ?, NULL)
  `).run(presentAccountId, nowIso, nowIso, missingAccountId, nowIso, nowIso);

  legacyDb.prepare(`
    INSERT INTO mailbox_sources (
      id, account_id, source_kind, address, provider_id, config_json,
      status, created_at, updated_at
    ) VALUES
    ('src_smoke_present', ?, 'imap', 'legacy-work@example.com', '127.0.0.1', ?, 'ready', ?, ?),
    ('src_smoke_missing', ?, 'imap', 'legacy-missing@example.com', '127.0.0.1', ?, 'ready', ?, ?)
  `).run(presentAccountId, imapConfigJson, nowIso, nowIso, missingAccountId, imapConfigJson, nowIso, nowIso);

  legacyDb.prepare(`
    INSERT INTO credential_refs (
      id, owner_account_id, source_id, secret_backend, secret_key,
      credential_kind, auth_method, status, created_at, updated_at, last_verified_at
    ) VALUES
    ('cred_smoke_present', ?, 'src_smoke_present', 'secret_vault', ?, 'imap_password', 'password', 'active', ?, ?, ?),
    ('cred_smoke_missing', ?, 'src_smoke_missing', 'secret_vault', ?, 'imap_password', 'password', 'active', ?, ?, NULL)
  `).run(presentAccountId, presentSecretKey, nowIso, nowIso, nowIso, missingAccountId, missingSecretKey, nowIso, nowIso);
  legacyDb.exec("COMMIT");
} finally {
  legacyDb.close();
}

const sourceShaBefore = crypto.createHash("sha256").update(fs.readFileSync(legacyDbPath)).digest("hex");

const firstResult = await importLegacyEasyEmailAmDatabase({
  sourceDatabasePath: legacyDbPath,
  targetDatabasePath: relationalDbPath,
  requireAllFoundationTables: false,
  vaultExistenceCheck: ({ secretKey }) => (secretKey === presentSecretKey ? "present" : "missing"),
});
const sourceShaAfter = crypto.createHash("sha256").update(fs.readFileSync(legacyDbPath)).digest("hex");
if (sourceShaAfter !== sourceShaBefore) {
  throw new Error("Legacy EasyEmailAM database SHA-256 mutated during account import.");
}
if (firstResult.receipt.importedCounts.accounts !== 2 || firstResult.receipt.reauthRequiredCount !== 1) {
  throw new Error(`Unexpected first import receipt: ${JSON.stringify(firstResult.receipt)}`);
}

const secondResult = await importLegacyEasyEmailAmDatabase({
  sourceDatabasePath: legacyDbPath,
  targetDatabasePath: relationalDbPath,
  requireAllFoundationTables: false,
  vaultExistenceCheck: ({ secretKey }) => (secretKey === presentSecretKey ? "present" : "missing"),
});
if (secondResult.receipt.importedCounts.accounts !== 0 || secondResult.receipt.skippedExistingCounts.accounts !== 2) {
  throw new Error(`Legacy importer was not idempotent: ${JSON.stringify(secondResult.receipt)}`);
}

console.log("LEGACY_ACCOUNT_IMPORT_OK=True");
console.log(`LEGACY_ACCOUNT_IMPORTED=${firstResult.receipt.importedCounts.accounts}`);
console.log(`LEGACY_ACCOUNT_REAUTH_MARKED=${firstResult.receipt.reauthRequiredCount}`);
