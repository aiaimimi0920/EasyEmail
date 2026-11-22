import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : undefined;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  if (hasFlag("--help") || hasFlag("-h")) {
    console.log(
      [
        "Usage: node scripts/import-legacy-easyemailam-db.mjs",
        "  --source <path/to/easyemailam.sqlite>",
        "  --target-db <path/to/easy-email-relational.sqlite3>",
        "  [--target-state <path/to/easy-email-state.json>]",
        "  [--backup-dir <directory>]",
        "  [--host-id <desktop-host-id>]",
      ].join("\n"),
    );
    return;
  }

  const sourceDatabasePath = argument("--source");
  const targetDatabasePath = argument("--target-db");
  const targetStateFilePath = argument("--target-state");
  const backupDirectory = argument("--backup-dir");
  const defaultHostId = argument("--host-id");

  if (!sourceDatabasePath || !targetDatabasePath) {
    console.error("Both --source and --target-db are required.");
    process.exitCode = 2;
    return;
  }

  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const databaseModuleUrl = pathToFileURL(
    resolve(scriptDir, "..", "service", "base", "dist", "src", "persistence", "relational", "database.js"),
  ).href;
  const { importLegacyEasyEmailAmDatabase } = await import(databaseModuleUrl);

  const result = await importLegacyEasyEmailAmDatabase({
    sourceDatabasePath: resolve(sourceDatabasePath),
    targetDatabasePath: resolve(targetDatabasePath),
    targetStateFilePath: targetStateFilePath
      ? resolve(targetStateFilePath)
      : join(dirname(resolve(targetDatabasePath)), "easy-email-state.json"),
    backupDirectory: backupDirectory ? resolve(backupDirectory) : undefined,
    defaultHostId,
  });

  console.log(JSON.stringify({
    status: "imported",
    receipt: result.receipt,
    sourceBackupDirectory: result.sourceBackupDirectory,
    targetPreImportBackupPath: result.targetPreImportBackupPath ?? null,
    targetStateBackupPath: result.targetStateBackupPath ?? null,
    skippedAnonymousCount: result.skippedAnonymousCount,
  }, null, 2));
}

main().catch((error) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : "LEGACY_IMPORT_FAILED";
  const message = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({ status: "failed", code, message }));
  process.exitCode = 1;
});
