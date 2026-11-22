import { homedir } from "node:os";
import { resolve } from "node:path";
import type {
  HostBinding,
  HostBindingQueryFilters,
  MailPersistenceStats,
  EasyEmailSnapshot,
  MailboxSession,
  MailboxSessionQueryFilters,
  ObservedMessage,
  ObservedMessageQueryFilters,
  ProviderInstance,
  ProviderInstanceQueryFilters,
} from "../domain/models.js";
import type { MailRegistrySeed } from "../domain/registry.js";
import type { MailStateQueryRepository, MailStateStore } from "./contracts.js";
import { runSqliteHelper, SQLITE_HELPER_TIMEOUT_MS, SqliteHelperError } from "./sqlite-helper-process.js";

// Serialize all operations on the same lexical path within this process.
// Other processes and symlink aliases still require a single database owner.
const queues = new Map<string, { tail: Promise<void>; count: number; inputBytes: number }>();
const MAX_QUEUED_OPERATIONS = 64;
const MAX_QUEUED_INPUT_BYTES = 128 * 1024 * 1024;

export interface SqliteMailStateStoreOptions {
  databasePath: string;
  pythonCommand?: string;
  helperScriptPath?: string;
}

function toSeed(snapshot: EasyEmailSnapshot | undefined): MailRegistrySeed | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    providerTypes: snapshot.providerTypes,
    runtimeTemplates: snapshot.runtimeTemplates,
    instances: snapshot.instances,
    bindings: snapshot.bindings,
    strategies: snapshot.strategies,
    credentialSets: snapshot.credentialSets,
    credentialBindings: snapshot.credentialBindings,
    sessions: snapshot.sessions,
    messages: snapshot.messages,
  };
}

function defaultHelperScriptPath(): string {
  return resolve(process.cwd(), "ops", "scripts", "sqlite_state_store.py");
}

function emptyStats(): MailPersistenceStats {
  return {
    providerInstanceCount: 0,
    hostBindingCount: 0,
    credentialSetCount: 0,
    credentialBindingCount: 0,
    mailboxSessionCount: 0,
    observedMessageCount: 0,
    resolvedSessionCount: 0,
    extractedCodeMessageCount: 0,
  };
}

export class SqliteMailStateStore implements MailStateStore, MailStateQueryRepository {
  private readonly pythonCommand: string;

  private readonly helperScriptPath: string;

  private readonly databasePath: string;

  private readonly queueKey: string;

  public constructor(options: SqliteMailStateStoreOptions) {
    this.pythonCommand = options.pythonCommand?.trim() || "python";
    this.helperScriptPath = options.helperScriptPath?.trim() || defaultHelperScriptPath();
    this.databasePath = resolve(options.databasePath.replace(/^~(?=$|[\\/])/, homedir()));
    this.queueKey = process.platform === "win32" ? this.databasePath.toLowerCase() : this.databasePath;
  }

  public async loadSeed(): Promise<MailRegistrySeed | undefined> {
    return toSeed(await this.loadSnapshot());
  }

  public async saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void> {
    // Capture mutable registry references at call time, not when the queue drains.
    await this.runHelper<unknown>("save", [], JSON.stringify(snapshot));
  }

  public async listProviderInstances(filters: ProviderInstanceQueryFilters = {}): Promise<ProviderInstance[]> {
    return await this.runHelper<ProviderInstance[]>("query", ["provider_instances", JSON.stringify(filters)]) ?? [];
  }

  public async listHostBindings(filters: HostBindingQueryFilters = {}): Promise<HostBinding[]> {
    return await this.runHelper<HostBinding[]>("query", ["host_bindings", JSON.stringify(filters)]) ?? [];
  }

  public async listMailboxSessions(filters: MailboxSessionQueryFilters = {}): Promise<MailboxSession[]> {
    return await this.runHelper<MailboxSession[]>("query", ["mailbox_sessions", JSON.stringify(filters)]) ?? [];
  }

  public async listObservedMessages(filters: ObservedMessageQueryFilters = {}): Promise<ObservedMessage[]> {
    return await this.runHelper<ObservedMessage[]>("query", ["observed_messages", JSON.stringify(filters)]) ?? [];
  }

  public async getStats(): Promise<MailPersistenceStats> {
    return await this.runHelper<MailPersistenceStats>("stats") ?? emptyStats();
  }

  private async loadSnapshot(): Promise<EasyEmailSnapshot | undefined> {
    const snapshot = await this.runHelper<EasyEmailSnapshot | null>("load");
    return snapshot ?? undefined;
  }

  private runHelper<T>(command: string, args: string[] = [], input?: string): Promise<T | undefined> {
    const queue = queues.get(this.queueKey) ?? { tail: Promise.resolve(), count: 0, inputBytes: 0 };
    const inputBytes = Buffer.byteLength(input ?? "", "utf8");
    if (queue.count >= MAX_QUEUED_OPERATIONS || queue.inputBytes + inputBytes > MAX_QUEUED_INPUT_BYTES) {
      return Promise.reject(new SqliteHelperError("SQLITE_HELPER_QUEUE_LIMIT"));
    }
    queues.set(this.queueKey, queue);
    queue.count += 1;
    queue.inputBytes += inputBytes;
    const deadline = Date.now() + SQLITE_HELPER_TIMEOUT_MS;
    const operation = queue.tail.then(() => {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw new SqliteHelperError("SQLITE_HELPER_TIMEOUT");
      return runSqliteHelper<T>({
        executable: this.pythonCommand,
        args: [this.helperScriptPath, command, this.databasePath, ...args],
        input,
        timeoutMs: remainingMs,
      });
    });
    const result = operation.finally(() => {
      queue.count -= 1;
      queue.inputBytes -= inputBytes;
      if (queue.count === 0 && queues.get(this.queueKey) === queue) queues.delete(this.queueKey);
    });
    queue.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function createSqliteMailStateStore(options: SqliteMailStateStoreOptions): SqliteMailStateStore {
  return new SqliteMailStateStore(options);
}
