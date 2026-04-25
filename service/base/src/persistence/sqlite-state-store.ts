import { execFileSync } from "node:child_process";
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

  public constructor(private readonly options: SqliteMailStateStoreOptions) {
    this.pythonCommand = options.pythonCommand?.trim() || "python";
    this.helperScriptPath = options.helperScriptPath?.trim() || defaultHelperScriptPath();
  }

  public async loadSeed(): Promise<MailRegistrySeed | undefined> {
    return toSeed(this.loadSnapshot());
  }

  public async saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void> {
    this.runHelper<unknown>("save", [], JSON.stringify(snapshot));
  }

  public async listProviderInstances(filters: ProviderInstanceQueryFilters = {}): Promise<ProviderInstance[]> {
    return this.runHelper<ProviderInstance[]>("query", ["provider_instances", JSON.stringify(filters)]) ?? [];
  }

  public async listHostBindings(filters: HostBindingQueryFilters = {}): Promise<HostBinding[]> {
    return this.runHelper<HostBinding[]>("query", ["host_bindings", JSON.stringify(filters)]) ?? [];
  }

  public async listMailboxSessions(filters: MailboxSessionQueryFilters = {}): Promise<MailboxSession[]> {
    return this.runHelper<MailboxSession[]>("query", ["mailbox_sessions", JSON.stringify(filters)]) ?? [];
  }

  public async listObservedMessages(filters: ObservedMessageQueryFilters = {}): Promise<ObservedMessage[]> {
    return this.runHelper<ObservedMessage[]>("query", ["observed_messages", JSON.stringify(filters)]) ?? [];
  }

  public async getStats(): Promise<MailPersistenceStats> {
    return this.runHelper<MailPersistenceStats>("stats") ?? emptyStats();
  }

  private loadSnapshot(): EasyEmailSnapshot | undefined {
    const snapshot = this.runHelper<EasyEmailSnapshot | null>("load");
    return snapshot ?? undefined;
  }

  private runHelper<T>(command: string, args: string[] = [], input?: string): T | undefined {
    const output = execFileSync(
      this.pythonCommand,
      [this.helperScriptPath, command, this.options.databasePath, ...args],
      {
        encoding: "utf-8",
        ...(input === undefined ? {} : { input }),
      },
    ).trim();

    if (!output) {
      return undefined;
    }

    return JSON.parse(output) as T;
  }
}

export function createSqliteMailStateStore(options: SqliteMailStateStoreOptions): SqliteMailStateStore {
  return new SqliteMailStateStore(options);
}
