import type { MailRegistrySeed } from "../domain/registry.js";
import type { EasyEmailSnapshot } from "../domain/models.js";
import type { MailStateDatabase, MailStateStore } from "./contracts.js";

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

export interface DatabaseMailStateStoreOptions {
  database: MailStateDatabase;
}

export class DatabaseMailStateStore implements MailStateStore {
  public constructor(private readonly options: DatabaseMailStateStoreOptions) {}

  public async loadSeed(): Promise<MailRegistrySeed | undefined> {
    return toSeed(await this.options.database.loadSnapshot());
  }

  public async saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void> {
    await this.options.database.saveSnapshot(snapshot);
  }
}

export function createDatabaseMailStateStore(options: DatabaseMailStateStoreOptions): DatabaseMailStateStore {
  return new DatabaseMailStateStore(options);
}

