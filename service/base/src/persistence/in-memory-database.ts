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
import type { MailStateDatabase } from "./contracts.js";
import {
  calculateMailPersistenceStats,
  queryHostBindingsFromSnapshot,
  queryMailboxSessionsFromSnapshot,
  queryObservedMessagesFromSnapshot,
  queryProviderInstancesFromSnapshot,
} from "./query-helpers.js";

export class InMemoryMailStateDatabase implements MailStateDatabase {
  private snapshot?: EasyEmailSnapshot;

  public constructor(seed?: EasyEmailSnapshot) {
    this.snapshot = seed ? JSON.parse(JSON.stringify(seed)) as EasyEmailSnapshot : undefined;
  }

  public async loadSnapshot(): Promise<EasyEmailSnapshot | undefined> {
    return this.snapshot ? JSON.parse(JSON.stringify(this.snapshot)) as EasyEmailSnapshot : undefined;
  }

  public async saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void> {
    this.snapshot = JSON.parse(JSON.stringify(snapshot)) as EasyEmailSnapshot;
  }

  public async listProviderInstances(filters: ProviderInstanceQueryFilters = {}): Promise<ProviderInstance[]> {
    return queryProviderInstancesFromSnapshot(this.snapshot ?? createEmptySnapshot(), filters);
  }

  public async listHostBindings(filters: HostBindingQueryFilters = {}): Promise<HostBinding[]> {
    return queryHostBindingsFromSnapshot(this.snapshot ?? createEmptySnapshot(), filters);
  }

  public async listMailboxSessions(filters: MailboxSessionQueryFilters = {}): Promise<MailboxSession[]> {
    return queryMailboxSessionsFromSnapshot(this.snapshot ?? createEmptySnapshot(), filters);
  }

  public async listObservedMessages(filters: ObservedMessageQueryFilters = {}): Promise<ObservedMessage[]> {
    return queryObservedMessagesFromSnapshot(this.snapshot ?? createEmptySnapshot(), filters);
  }

  public async getStats(): Promise<MailPersistenceStats> {
    return calculateMailPersistenceStats(this.snapshot ?? createEmptySnapshot());
  }
}

function createEmptySnapshot(): EasyEmailSnapshot {
  return {
    providerTypes: [],
    runtimeTemplates: [],
    instances: [],
    bindings: [],
    strategies: [],
    credentialSets: [],
    credentialBindings: [],
    sessions: [],
    messages: [],
  };
}

export function createInMemoryMailStateDatabase(seed?: EasyEmailSnapshot): InMemoryMailStateDatabase {
  return new InMemoryMailStateDatabase(seed);
}

