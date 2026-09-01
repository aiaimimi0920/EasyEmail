import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { MailStateStore } from "../../src/persistence/contracts.js";
import {
  resolveRelationalDatabasePath,
  SqliteRelationalDatabase,
} from "../../src/persistence/relational/database.js";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";
import { startEasyEmailServiceRuntime } from "../../src/runtime/runtime.js";

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function provePortCanBeRebound(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function proveRelationalDatabaseCanBeReopened(databasePath: string): void {
  // A same-path open fails until close() clears the repository's process-local guard.
  const database = new SqliteRelationalDatabase({ databasePath });
  database.close();
}

describe("runtime startup cleanup", () => {
  it("does not acquire the relational database before service bootstrap succeeds", async () => {
    const directory = await mkdtemp(join(tmpdir(), "easy-email-startup-cleanup-"));
    const config = parseEasyEmailServiceRuntimeConfig({
      server: { host: "127.0.0.1", port: 0 },
      maintenance: { enabled: false },
      persistence: {
        enabled: true,
        driver: "file",
        filePath: join(directory, "state.json"),
        databasePath: join(directory, "snapshot.sqlite3"),
      },
      providers: { enabledProviders: [] },
    });
    const options = { config };
    Object.defineProperty(options, "strategies", {
      enumerable: true,
      get() {
        throw new Error("intentional service bootstrap failure");
      },
    });

    try {
      await expect(startEasyEmailServiceRuntime(options)).rejects.toThrow(
        "intentional service bootstrap failure",
      );
      expect(() => proveRelationalDatabaseCanBeReopened(
        resolveRelationalDatabasePath(config.persistence.databasePath),
      )).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("closes the HTTP server and owned relational database when the initial snapshot flush fails", async () => {
    const port = await reservePort();
    const directory = await mkdtemp(join(tmpdir(), "easy-email-startup-cleanup-"));
    const failingStore: MailStateStore = {
      async loadSeed() {
        return undefined;
      },
      async saveSnapshot() {
        throw new Error("intentional startup flush failure");
      },
    };
    const config = parseEasyEmailServiceRuntimeConfig({
      server: { host: "127.0.0.1", port },
      maintenance: { enabled: false },
      persistence: {
        enabled: true,
        driver: "file",
        intervalMs: 60_000,
        filePath: join(directory, "state.json"),
        databasePath: join(directory, "snapshot.sqlite3"),
      },
      providers: { enabledProviders: [] },
    });

    try {
      await expect(startEasyEmailServiceRuntime({
        config,
        stateStore: failingStore,
      })).rejects.toThrow("intentional startup flush failure");
      await expect(provePortCanBeRebound(port)).resolves.toBeUndefined();
      expect(() => proveRelationalDatabaseCanBeReopened(
        resolveRelationalDatabasePath(config.persistence.databasePath),
      )).not.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
