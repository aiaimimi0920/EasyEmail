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

export type MailPersistenceDriver = "file" | "database" | "sqlite";

export interface MailStateStore {
  loadSeed(): Promise<MailRegistrySeed | undefined>;
  saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void>;
}

export interface MailStateQueryRepository {
  listProviderInstances(filters?: ProviderInstanceQueryFilters): Promise<ProviderInstance[]>;
  listHostBindings(filters?: HostBindingQueryFilters): Promise<HostBinding[]>;
  listMailboxSessions(filters?: MailboxSessionQueryFilters): Promise<MailboxSession[]>;
  listObservedMessages(filters?: ObservedMessageQueryFilters): Promise<ObservedMessage[]>;
  getStats(): Promise<MailPersistenceStats>;
}

export interface MailStateDatabase extends MailStateQueryRepository {
  loadSnapshot(): Promise<EasyEmailSnapshot | undefined>;
  saveSnapshot(snapshot: EasyEmailSnapshot): Promise<void>;
}

