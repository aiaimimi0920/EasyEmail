import type {
  AuthenticationLinkResult,
  HostBinding,
  HostBindingQueryFilters,
  MailProviderTypeKey,
  EasyEmailSnapshot,
  MailboxSession,
  ObservedMessage,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderInstance,
  ProviderTypeDefinition,
  RuntimeTemplate,
  StrategyProfile,
  VerificationCodeResult,
} from "./models.js";
import type { CredentialUseCase } from "../shared/index.js";

export interface MailRegistrySeed {
  providerTypes?: ProviderTypeDefinition[];
  runtimeTemplates?: RuntimeTemplate[];
  instances?: ProviderInstance[];
  bindings?: HostBinding[];
  strategies?: StrategyProfile[];
  credentialSets?: ProviderCredentialSet[];
  credentialBindings?: ProviderCredentialBinding[];
  sessions?: MailboxSession[];
  messages?: ObservedMessage[];
}

export class MailRegistry {
  private readonly providerTypes = new Map<MailProviderTypeKey, ProviderTypeDefinition>();

  private readonly runtimeTemplates = new Map<string, RuntimeTemplate>();

  private readonly instances = new Map<string, ProviderInstance>();

  private readonly bindings = new Map<string, HostBinding>();

  private readonly strategies = new Map<string, StrategyProfile>();

  private readonly credentialSets = new Map<string, ProviderCredentialSet>();

  private readonly credentialBindings = new Map<string, ProviderCredentialBinding>();

  private readonly sessions = new Map<string, MailboxSession>();

  private readonly messages = new Map<string, ObservedMessage>();

  public constructor(seed: MailRegistrySeed = {}) {
    for (const providerType of seed.providerTypes ?? []) {
      this.providerTypes.set(providerType.key, providerType);
    }

    for (const runtimeTemplate of seed.runtimeTemplates ?? []) {
      this.runtimeTemplates.set(runtimeTemplate.id, runtimeTemplate);
    }

    for (const instance of seed.instances ?? []) {
      this.instances.set(instance.id, instance);
    }

    for (const binding of seed.bindings ?? []) {
      this.bindings.set(this.createBindingKey(binding.hostId, binding.providerTypeKey), binding);
    }

    for (const strategy of seed.strategies ?? []) {
      this.strategies.set(strategy.id, strategy);
    }

    for (const credentialSet of seed.credentialSets ?? []) {
      this.credentialSets.set(credentialSet.id, credentialSet);
    }

    for (const credentialBinding of seed.credentialBindings ?? []) {
      this.credentialBindings.set(this.createCredentialBindingKey(credentialBinding.providerInstanceId, credentialBinding.credentialSetId), credentialBinding);
    }

    for (const session of seed.sessions ?? []) {
      this.sessions.set(session.id, session);
    }

    for (const message of seed.messages ?? []) {
      this.messages.set(message.id, message);
    }
  }

  public listProviderTypes(): ProviderTypeDefinition[] {
    return [...this.providerTypes.values()];
  }

  public getProviderType(key: MailProviderTypeKey): ProviderTypeDefinition | undefined {
    return this.providerTypes.get(key);
  }

  public saveProviderType(providerType: ProviderTypeDefinition): void {
    this.providerTypes.set(providerType.key, providerType);
  }

  public listRuntimeTemplates(): RuntimeTemplate[] {
    return [...this.runtimeTemplates.values()];
  }

  public findRuntimeTemplateById(id: string): RuntimeTemplate | undefined {
    return this.runtimeTemplates.get(id);
  }

  public saveRuntimeTemplate(template: RuntimeTemplate): void {
    this.runtimeTemplates.set(template.id, template);
  }

  public listInstances(): ProviderInstance[] {
    return [...this.instances.values()];
  }

  public findInstanceById(id: string): ProviderInstance | undefined {
    return this.instances.get(id);
  }

  public saveInstance(instance: ProviderInstance): void {
    this.instances.set(instance.id, instance);
  }

  public listActiveInstancesByType(typeKey: MailProviderTypeKey): ProviderInstance[] {
    return [...this.instances.values()].filter(
      (instance) => instance.providerTypeKey === typeKey && instance.status !== "offline" && instance.status !== "cooling",
    );
  }

  public listStrategies(): StrategyProfile[] {
    return [...this.strategies.values()];
  }

  public findStrategyById(id: string): StrategyProfile | undefined {
    return this.strategies.get(id);
  }

  public saveStrategy(strategy: StrategyProfile): void {
    this.strategies.set(strategy.id, strategy);
  }

  public listCredentialSets(): ProviderCredentialSet[] {
    return [...this.credentialSets.values()];
  }

  public findCredentialSetById(id: string): ProviderCredentialSet | undefined {
    return this.credentialSets.get(id);
  }

  public saveCredentialSet(credentialSet: ProviderCredentialSet): void {
    this.credentialSets.set(credentialSet.id, credentialSet);
  }

  public deleteCredentialSet(id: string): void {
    this.credentialSets.delete(id);
  }

  public listCredentialBindings(): ProviderCredentialBinding[] {
    return [...this.credentialBindings.values()];
  }

  public saveCredentialBinding(binding: ProviderCredentialBinding): void {
    this.credentialBindings.set(this.createCredentialBindingKey(binding.providerInstanceId, binding.credentialSetId), binding);
  }

  public deleteCredentialBindingsForInstance(providerInstanceId: string): void {
    for (const [key, binding] of this.credentialBindings.entries()) {
      if (binding.providerInstanceId === providerInstanceId) {
        this.credentialBindings.delete(key);
      }
    }
  }

  public resolveCredentialSetsForInstance(
    providerInstanceId: string,
    useCase?: CredentialUseCase,
  ): ProviderCredentialSet[] {
    const bindings = [...this.credentialBindings.values()]
      .filter((binding) => binding.providerInstanceId === providerInstanceId)
      .filter((binding) => !useCase || !binding.useCases || binding.useCases.includes(useCase))
      .sort((left, right) => right.priority - left.priority || left.credentialSetId.localeCompare(right.credentialSetId));

    const sets = bindings
      .map((binding) => this.credentialSets.get(binding.credentialSetId))
      .filter((item): item is ProviderCredentialSet => item !== undefined)
      .filter((set) => !useCase || set.useCases.includes(useCase));

    return sets;
  }

  public saveBinding(binding: HostBinding): void {
    this.bindings.set(this.createBindingKey(binding.hostId, binding.providerTypeKey), binding);
  }

  public deleteBinding(hostId: string, providerTypeKey: MailProviderTypeKey): void {
    this.bindings.delete(this.createBindingKey(hostId, providerTypeKey));
  }

  public findBinding(hostId: string, providerTypeKey: MailProviderTypeKey): HostBinding | undefined {
    return this.bindings.get(this.createBindingKey(hostId, providerTypeKey));
  }

  public listBindings(): HostBinding[] {
    return [...this.bindings.values()];
  }

  public saveSession(session: MailboxSession): void {
    this.sessions.set(session.id, session);
  }

  public deleteSession(id: string): void {
    this.sessions.delete(id);
  }

  public findSessionById(id: string): MailboxSession | undefined {
    return this.sessions.get(id);
  }

  public findLatestSessionByEmailAddress(
    emailAddress: string,
    providerTypeKey?: MailProviderTypeKey,
  ): MailboxSession | undefined {
    const normalizedEmailAddress = emailAddress.trim().toLowerCase();
    if (!normalizedEmailAddress) {
      return undefined;
    }

    return this.listSessions()
      .filter((session) => session.emailAddress.trim().toLowerCase() === normalizedEmailAddress)
      .filter((session) => !providerTypeKey || session.providerTypeKey === providerTypeKey)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  }

  public listSessions(): MailboxSession[] {
    return [...this.sessions.values()];
  }

  public saveMessage(message: ObservedMessage): void {
    this.messages.set(message.id, message);
  }

  public deleteMessage(id: string): void {
    this.messages.delete(id);
  }

  public listMessages(): ObservedMessage[] {
    return [...this.messages.values()];
  }

  public listMessagesBySession(sessionId: string): ObservedMessage[] {
    return [...this.messages.values()].filter((message) => message.sessionId === sessionId);
  }

  public findLatestAuthenticationLink(sessionId: string): AuthenticationLinkResult | undefined {
    const session = this.findSessionById(sessionId);
    const notBeforeAt = parseObservedAt(session?.metadata.notBeforeAt ?? session?.createdAt);
    const resolvedMessage = this.listMessagesBySession(sessionId)
      .filter((message) => Array.isArray(message.actionLinks) && message.actionLinks.length > 0)
      .filter((message) => {
        if (notBeforeAt === undefined) {
          return true;
        }
        const observedAt = parseObservedAt(message.observedAt);
        return observedAt !== undefined && observedAt >= notBeforeAt;
      })
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];

    const primaryLink = resolvedMessage?.actionLinks?.[0];
    if (!resolvedMessage || !primaryLink) {
      return undefined;
    }

    return {
      sessionId,
      providerInstanceId: resolvedMessage.providerInstanceId,
      url: primaryLink.url,
      label: primaryLink.label,
      source: primaryLink.source,
      observedMessageId: resolvedMessage.id,
      receivedAt: resolvedMessage.observedAt,
      ...(resolvedMessage.actionLinks && resolvedMessage.actionLinks.length > 0
        ? { links: [...resolvedMessage.actionLinks] }
        : {}),
    };
  }

  public findLatestVerificationCode(sessionId: string): VerificationCodeResult | undefined {
    const resolvedMessage = this.listMessagesBySession(sessionId)
      .filter((message) => message.extractedCode && message.codeSource)
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt))[0];

    if (!resolvedMessage?.extractedCode || !resolvedMessage.codeSource) {
      return undefined;
    }

    return {
      sessionId,
      providerInstanceId: resolvedMessage.providerInstanceId,
      code: resolvedMessage.extractedCode,
      source: resolvedMessage.codeSource,
      observedMessageId: resolvedMessage.id,
      receivedAt: resolvedMessage.observedAt,
      ...(resolvedMessage.extractedCandidates && resolvedMessage.extractedCandidates.length > 0
        ? { candidates: [...resolvedMessage.extractedCandidates] }
        : {}),
    };
  }

  public snapshot(): EasyEmailSnapshot {
    return {
      providerTypes: this.listProviderTypes(),
      runtimeTemplates: this.listRuntimeTemplates(),
      instances: this.listInstances(),
      bindings: this.listBindings(),
      strategies: this.listStrategies(),
      credentialSets: this.listCredentialSets(),
      credentialBindings: this.listCredentialBindings(),
      sessions: this.listSessions(),
      messages: this.listMessages(),
    };
  }

  private createBindingKey(hostId: string, providerTypeKey: MailProviderTypeKey): string {
    return `${hostId}::${providerTypeKey}`;
  }

  private createCredentialBindingKey(providerInstanceId: string, credentialSetId: string): string {
    return `${providerInstanceId}::${credentialSetId}`;
  }
}

function parseObservedAt(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

