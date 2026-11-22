import { normalizeMailProviderTypeKey, type MailProviderTypeKey } from "../domain/models.js";
import type { MailRegistry } from "../domain/registry.js";
import type { MailProviderAdapter } from "../providers/contracts.js";
import {
  cleanupMailboxMessages,
  cleanupMailboxSessions,
  expireMailboxSessions,
  refreshInstanceHealth,
} from "../workers/index.js";
import {
  recoverMailboxSessionByEmailAddress,
  type MailboxSessionRecoveryInput,
  type MailboxSessionRecoveryResult,
} from "./mailbox-session-recovery.js";
import { resetProviderOperationalState } from "./provider-operational-state.js";

interface EasyEmailRegistryOperationsOptions {
  registry: MailRegistry;
  adapterMap: Map<MailProviderTypeKey, MailProviderAdapter>;
  syncOperationalState: (now?: Date) => void;
}

export class EasyEmailRegistryOperations {
  public constructor(private readonly options: EasyEmailRegistryOperationsOptions) {}

  public getSnapshot() {
    this.options.syncOperationalState();
    return this.options.registry.snapshot();
  }

  public listProviderTypes() {
    return this.options.registry.listProviderTypes();
  }

  public getProviderType(typeKey: MailProviderTypeKey) {
    return this.options.registry.getProviderType(normalizeMailProviderTypeKey(typeKey) ?? typeKey);
  }

  public listRuntimeTemplates() {
    return this.options.registry.listRuntimeTemplates();
  }

  public listInstances() {
    this.options.syncOperationalState();
    return this.options.registry.listInstances();
  }

  public findInstanceById(instanceId: string) {
    this.options.syncOperationalState();
    return this.options.registry.findInstanceById(instanceId);
  }

  public listBindings() {
    return this.options.registry.listBindings();
  }

  public listCredentialSets() {
    return this.options.registry.listCredentialSets();
  }

  public listCredentialBindings() {
    return this.options.registry.listCredentialBindings();
  }

  public listStrategies() {
    return this.options.registry.listStrategies();
  }

  public findMailboxSessionByEmailAddress(
    emailAddress: string,
    providerTypeKey?: MailProviderTypeKey,
  ) {
    this.options.syncOperationalState();
    return this.options.registry.findLatestSessionByEmailAddress(
      emailAddress,
      providerTypeKey ? (normalizeMailProviderTypeKey(providerTypeKey) ?? providerTypeKey) : undefined,
    );
  }

  public async recoverMailboxSessionByEmailAddress(
    input: MailboxSessionRecoveryInput,
    now: Date,
  ): Promise<MailboxSessionRecoveryResult> {
    return await recoverMailboxSessionByEmailAddress({
      input,
      registry: this.options.registry,
      adapterMap: this.options.adapterMap,
      now,
      syncOperationalState: (at) => this.options.syncOperationalState(at),
    });
  }

  public expireSessions(now: Date) {
    return expireMailboxSessions(this.options.registry, now);
  }

  public cleanupMessages(keepRecentCount?: number) {
    return cleanupMailboxMessages(this.options.registry, { keepRecentCount });
  }

  public cleanupSessions(keepRecentCount?: number) {
    return cleanupMailboxSessions(this.options.registry, { keepRecentCount });
  }

  public refreshHealth() {
    this.options.syncOperationalState();
    return refreshInstanceHealth(this.options.registry);
  }

  public runMaintenance(now: Date) {
    this.options.syncOperationalState(now);
    return {
      expired: expireMailboxSessions(this.options.registry, now),
      cleanedSessions: cleanupMailboxSessions(this.options.registry),
      cleaned: cleanupMailboxMessages(this.options.registry),
      refreshed: refreshInstanceHealth(this.options.registry),
    };
  }

  public resetOperationalState(now: Date) {
    return resetProviderOperationalState(this.options.registry, now);
  }
}
