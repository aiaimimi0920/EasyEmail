import { EasyEmailError } from "../domain/errors.js";
import type { EasyEmailServiceRuntimeConfig } from "../runtime/config.js";
import type { MailStateDatabase, MailStateQueryRepository, MailStateStore } from "./contracts.js";
import { createDatabaseMailStateStore } from "./database-state-store.js";
import { createFileMailStateStore } from "./file-state-store.js";
import { createSqliteMailStateStore } from "./sqlite-state-store.js";

export interface MailStateStoreFactoryOptions {
  config: EasyEmailServiceRuntimeConfig["persistence"];
  database?: MailStateDatabase;
}

export interface MailStateQueryRepositoryFactoryOptions {
  config: EasyEmailServiceRuntimeConfig["persistence"];
  database?: MailStateDatabase;
}

export function createMailStateStoreFromRuntimeConfig(
  options: MailStateStoreFactoryOptions,
): MailStateStore | undefined {
  if (!options.config.enabled) {
    return undefined;
  }

  if (options.config.driver === "file") {
    return createFileMailStateStore({ filePath: options.config.filePath });
  }

  if (options.config.driver === "sqlite") {
    return createSqliteMailStateStore({
      databasePath: options.config.databasePath,
      pythonCommand: options.config.pythonCommand,
      helperScriptPath: options.config.sqliteHelperScriptPath,
    });
  }

  if (options.config.driver === "database") {
    if (!options.database) {
      throw new EasyEmailError(
        "MAIL_DATABASE_STORE_MISSING",
        "Persistence driver is set to database but no MailStateDatabase was provided.",
      );
    }

    return createDatabaseMailStateStore({ database: options.database });
  }

  throw new EasyEmailError(
    "MAIL_PERSISTENCE_DRIVER_UNSUPPORTED",
    `Unsupported mail persistence driver: ${options.config.driver}.`,
  );
}

export function createMailStateQueryRepositoryFromRuntimeConfig(
  options: MailStateQueryRepositoryFactoryOptions,
): MailStateQueryRepository | undefined {
  if (!options.config.enabled) {
    return undefined;
  }

  if (options.config.driver === "sqlite") {
    return createSqliteMailStateStore({
      databasePath: options.config.databasePath,
      pythonCommand: options.config.pythonCommand,
      helperScriptPath: options.config.sqliteHelperScriptPath,
    });
  }

  if (options.config.driver === "database") {
    if (!options.database) {
      throw new EasyEmailError(
        "MAIL_DATABASE_STORE_MISSING",
        "Persistence driver is set to database but no MailStateDatabase was provided.",
      );
    }

    return options.database;
  }

  return undefined;
}

