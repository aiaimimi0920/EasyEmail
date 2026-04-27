import { readFileSync } from "node:fs";
import {
  createBootstrappedEasyEmailService,
  type EasyEmailBootstrapOptions,
} from "../service/bootstrap.js";
import {
  MAIL_PROVIDER_TYPES,
  createDefaultProviderInstances,
} from "../defaults/index.js";
import {
  createDdgMailAliasProvider,
  type MailAliasProvider,
} from "../alias/index.js";
import {
  buildCredentialSummary,
  createBasicAuthCredentialSetFromFile,
  createBasicAuthCredentialSetFromLines,
  createValueCredentialSetFromFile,
  createValueCredentialSetFromLines,
  parseCredentialSetsJson,
  serializeCredentialSummary,
  type CredentialSetDefinition,
} from "../shared/index.js";
import {
  materializeProviderCredentialSets,
  createProviderCredentialBindings,
  resolveBoundCredentialSets,
} from "../service/credentials.js";
import { mergeEasyEmailRegistrySeeds } from "../service/catalog.js";
import { EasyEmailHttpHandler } from "../http/handler.js";
import { createEasyEmailHttpServer, type StartedEasyEmailHttpServer } from "../http/server.js";
import {
  createMailStateQueryRepositoryFromRuntimeConfig,
  createMailStateStoreFromRuntimeConfig,
} from "../persistence/factory.js";
import type { MailStateDatabase, MailStateQueryRepository, MailStateStore } from "../persistence/contracts.js";
import {
  loadEasyEmailServiceRuntimeConfigFromEnvironment,
  type EasyEmailServiceRuntimeConfig,
} from "./config.js";
import { startMailMaintenanceLoop, type MailMaintenanceLoop } from "./maintenance-loop.js";
import { startMailStatePersistenceLoop, type MailStatePersistenceLoop } from "./persistence-loop.js";
import { createMailAliasService } from "../alias/service.js";
import type {
  ProviderCredentialSet,
  ProviderInstance,
  RegisterCloudflareTempEmailRuntimeRequest,
} from "../domain/models.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import type { MailRegistrySeed } from "../domain/registry.js";

export interface EasyEmailServiceRuntimeOptions extends EasyEmailBootstrapOptions {
  config?: EasyEmailServiceRuntimeConfig;
  stateStore?: MailStateStore;
  queryRepository?: MailStateQueryRepository;
  databaseState?: MailStateDatabase;
}

export interface StartedEasyEmailServiceRuntime {
  config: EasyEmailServiceRuntimeConfig;
  service: EasyEmailService;
  handler: EasyEmailHttpHandler;
  server: StartedEasyEmailHttpServer;
  maintenanceLoop?: MailMaintenanceLoop;
  persistenceLoop?: MailStatePersistenceLoop;
  queryRepository?: MailStateQueryRepository;
  close(): Promise<void>;
}

function parseDdgAliasTokens(raw: string | undefined): string[] {
  if (!raw?.trim()) {
    return [];
  }

  return raw
    .split(/[\r\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item) => item.startsWith("#") === false);
}

function loadDdgAliasTokensFromFile(path: string | undefined): string[] {
  if (!path?.trim()) {
    return [];
  }

  try {
    return parseDdgAliasTokens(readFileSync(path, { encoding: "utf-8" }));
  } catch {
    return [];
  }
}

function resolveDdgAliasTokens(provider: EasyEmailServiceRuntimeConfig["aliasEmail"]["providers"][number]): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];

  for (const token of [
    ...(provider.tokens ?? []),
    ...parseDdgAliasTokens(provider.tokensText),
    ...loadDdgAliasTokensFromFile(provider.tokensFile),
  ]) {
    const normalized = token?.trim();
    if (!normalized || seen.has(normalized)) {
      continue;
    }

    seen.add(normalized);
    tokens.push(normalized);
  }

  return tokens;
}

function createAliasProvidersFromRuntimeConfig(config: EasyEmailServiceRuntimeConfig): MailAliasProvider[] {
  const providers: MailAliasProvider[] = [];

  for (const provider of config.aliasEmail.providers) {
    if (provider.key === "ddg") {
      providers.push(createDdgMailAliasProvider({
        enabled: provider.enabled,
        apiBaseUrl: provider.apiBaseUrl,
        tokens: resolveDdgAliasTokens(provider),
        dailyLimit: provider.dailyLimit,
        cooldownMs: provider.cooldownMs,
        stateFilePath: provider.stateFilePath,
      }));
    }
  }

  return providers;
}

function ensureDefaultProviderCatalog(service: EasyEmailService, now: Date): void {
  for (const providerType of MAIL_PROVIDER_TYPES) {
    if (!service.getProviderType(providerType.key)) {
      service.saveProviderType(providerType);
    }
  }

  for (const instance of createDefaultProviderInstances(now)) {
    if (!service.findInstanceById(instance.id)) {
      service.saveProviderInstance(instance);
    }
  }
}

function isQueryRepository(value: unknown): value is MailStateQueryRepository {
  if (!value || typeof value !== "object") {
    return false;
  }

  return [
    "listProviderInstances",
    "listHostBindings",
    "listMailboxSessions",
    "listObservedMessages",
    "getStats",
  ].every((key) => typeof (value as Record<string, unknown>)[key] === "function");
}

export async function startEasyEmailServiceRuntime(
  options: EasyEmailServiceRuntimeOptions = {},
): Promise<StartedEasyEmailServiceRuntime> {
  const config = options.config ?? await loadEasyEmailServiceRuntimeConfigFromEnvironment(process.env);
  const stateStore = options.stateStore ?? createMailStateStoreFromRuntimeConfig({
    config: config.persistence,
    database: options.databaseState,
  });
  const queryRepository = options.queryRepository
    ?? (isQueryRepository(stateStore) ? stateStore : undefined)
    ?? createMailStateQueryRepositoryFromRuntimeConfig({
      config: config.persistence,
      database: options.databaseState,
    });
  const persistedSeed = stateStore ? await stateStore.loadSeed() : undefined;
  const service = createBootstrappedEasyEmailService({
    ...options,
    strictProviderMode: config.strictProviderMode,
    defaultStrategyMode: config.defaultStrategyMode,
    routingProfiles: config.routingProfiles,
    aliasService: options.aliasService ?? createMailAliasService({
      providers: createAliasProvidersFromRuntimeConfig(config),
    }),
    registrySeed: mergeEasyEmailRegistrySeeds(persistedSeed, options.registrySeed),
  });
  ensureDefaultProviderCatalog(service, new Date());
  configureDefaultStrategyProfile(service, config);
  configureProviderAvailability(service, config);
  configureGptMailProviderInstance(service, config);
  configureMoemailProviderInstance(service, config);
  configureIm215ProviderInstance(service, config);
  configureMail2925ProviderInstance(service, config);
  await configureCloudflareTempEmailProviderInstance(service, config);
  service.resetOperationalState(new Date());
 
  const handler = new EasyEmailHttpHandler(service, queryRepository);
  const server = await createEasyEmailHttpServer(handler, {
    hostname: config.hostname,
    port: config.port,
    apiKey: config.apiKey,
  });

  const maintenanceLoop = config.maintenance.enabled
    ? startMailMaintenanceLoop(service, {
        intervalMs: config.maintenance.intervalMs,
        keepRecentCount: config.maintenance.keepRecentCount,
        keepRecentSessionCount: config.maintenance.keepRecentSessionCount,
        activeProbeEnabled: config.maintenance.activeProbeEnabled,
        activeProbeIntervalMs: config.maintenance.activeProbeIntervalMs,
      })
    : undefined;

  const persistenceLoop = stateStore
    ? startMailStatePersistenceLoop(service, stateStore, {
        intervalMs: config.persistence.intervalMs,
      })
    : undefined;

  if (persistenceLoop) {
    await persistenceLoop.flush();
  }

  return {
    config,
    service,
    handler,
    server,
    maintenanceLoop,
    persistenceLoop,
    queryRepository,
    async close() {
      maintenanceLoop?.stop();
      if (persistenceLoop) {
        await persistenceLoop.stop();
      }
      await server.close();
    },
  };
}

function configureDefaultStrategyProfile(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const strategyProfileId = config.defaultStrategyProfileId?.trim();
  if (!strategyProfileId) {
    return;
  }

  const snapshot = service.getSnapshot();
  const strategyProfile = snapshot.strategies.find((item) => item.id === strategyProfileId);
  if (!strategyProfile) {
    console.warn(`[easy_email] Default strategy profile not found: ${strategyProfileId}`);
    return;
  }

  for (const providerType of snapshot.providerTypes) {
    if (providerType.defaultStrategyKey === strategyProfile.key) {
      continue;
    }
    service.saveProviderType({
      ...providerType,
      defaultStrategyKey: strategyProfile.key,
    });
  }
}

function configureProviderAvailability(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const enabled = config.enabledProviders;
  if (!enabled || enabled.length === 0) {
    return;
  }

  const enabledSet = new Set(enabled);
  for (const instance of service.listInstances()) {
    if (instance.runtimeKind !== "external") {
      continue;
    }

    const nextStatus = enabledSet.has(instance.providerTypeKey) ? "active" : "offline";
    if (nextStatus === instance.status) {
      continue;
    }

    service.saveProviderInstance({
      ...instance,
      status: nextStatus,
      updatedAt: new Date().toISOString(),
    });
  }
}

function isExternalProviderEnabled(
  config: EasyEmailServiceRuntimeConfig,
  providerTypeKey: ProviderInstance["providerTypeKey"],
): boolean {
  const enabled = config.enabledProviders;
  if (!enabled || enabled.length === 0) {
    return true;
  }

  return enabled.includes(providerTypeKey);
}

function buildInlineCredentialSet(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  return createValueCredentialSetFromLines(raw, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildFileCredentialSet(
  rawPath: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!rawPath?.trim()) {
    return undefined;
  }

  return createValueCredentialSetFromFile(rawPath, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildInlineBasicAuthCredentialSet(
  username: string | undefined,
  password: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!username?.trim() || !password?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromLines(`${username.trim()}|${password.trim()}`, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildBasicAuthCredentialSet(
  raw: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromLines(raw, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function buildBasicAuthCredentialSetFromFile(
  rawPath: string | undefined,
  options: {
    id: string;
    displayName: string;
    priority: number;
  },
): CredentialSetDefinition | undefined {
  if (!rawPath?.trim()) {
    return undefined;
  }

  return createBasicAuthCredentialSetFromFile(rawPath, {
    id: options.id,
    displayName: options.displayName,
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: options.priority,
  });
}

function resolveAndPersistCredentialSets(
  service: EasyEmailService,
  snapshot: import("../domain/models.js").EasyEmailSnapshot,
  instance: ProviderInstance,
  effectiveSets: CredentialSetDefinition[],
): { formalSets: ProviderCredentialSet[]; now: Date } {
  const now = new Date();
  const persistedSets = resolveBoundCredentialSets(snapshot, instance.id);
  const formalSets = effectiveSets.length > 0
    ? materializeProviderCredentialSets(instance, effectiveSets, now)
    : persistedSets;

  if (effectiveSets.length > 0) {
    for (const credentialSet of formalSets) {
      service.saveCredentialSet(credentialSet);
    }
    service.replaceCredentialBindingsForInstance(instance.id, createProviderCredentialBindings(instance.id, formalSets, now));
  }

  return { formalSets, now };
}

function buildProviderMetadataWithCredentials(
  instance: ProviderInstance,
  formalSets: ProviderCredentialSet[],
  extraMetadata: Record<string, string>,
): Record<string, string> {
  const { credentialSetsJson: _previousSets, credentialSummaryJson: _previousSummary, ...baseMetadata } = instance.metadata;
  const metadata: Record<string, string> = {
    ...baseMetadata,
    ...extraMetadata,
  };

  if (formalSets.length > 0) {
    metadata.credentialSetsJson = JSON.stringify(formalSets);
    metadata.credentialSummaryJson = serializeCredentialSummary(
      buildCredentialSummary(`mail:${instance.providerTypeKey}:${instance.id}`, formalSets),
    );
  }

  return metadata;
}

function configureApiKeyProviderInstance(
  service: EasyEmailService,
  instanceId: string,
  providerTypeKey: ProviderInstance["providerTypeKey"],
  enabled: boolean,
  config: {
    baseUrl?: string;
    apiKey?: string;
    keysFile?: string;
    keysText?: string;
    credentialSetsJson?: string;
    domain?: string;
    extraMetadata?: Record<string, string | undefined>;
  },
  setLabels: {
    inlineId: string;
    inlineDisplayName: string;
    textId: string;
    textDisplayName: string;
    fileId: string;
    fileDisplayName: string;
  },
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.providerTypeKey === providerTypeKey);
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.credentialSetsJson);
  const inlineSet = buildInlineCredentialSet(config.apiKey, {
    id: setLabels.inlineId,
    displayName: setLabels.inlineDisplayName,
    priority: 200,
  });
  const textSet = buildInlineCredentialSet(config.keysText, {
    id: setLabels.textId,
    displayName: setLabels.textDisplayName,
    priority: 180,
  });
  const fileSet = buildFileCredentialSet(config.keysFile, {
    id: setLabels.fileId,
    displayName: setLabels.fileDisplayName,
    priority: 160,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [inlineSet, textSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.baseUrl ? { apiBase: config.baseUrl } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
    ...Object.fromEntries(
      Object.entries(config.extraMetadata ?? {}).filter(([, value]) => typeof value === "string" && value.trim()),
    ) as Record<string, string>,
  });

  service.saveProviderInstance({
    ...instance,
    status: enabled && formalSets.length > 0 ? "active" : "offline",
    connectionRef: config.baseUrl?.trim() || instance.connectionRef,
    metadata,
    updatedAt: now.toISOString(),
  });
}

function configureBasicAuthProviderInstance(
  service: EasyEmailService,
  instanceId: string,
  providerTypeKey: ProviderInstance["providerTypeKey"],
  enabled: boolean,
  config: {
    baseUrl?: string;
    username?: string;
    password?: string;
    accountsFile?: string;
    accountsText?: string;
    credentialSetsJson?: string;
    domain?: string;
    extraMetadata?: Record<string, string | undefined>;
  },
  setLabels: {
    inlineId: string;
    inlineDisplayName: string;
    textId: string;
    textDisplayName: string;
    fileId: string;
    fileDisplayName: string;
  },
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === instanceId && item.providerTypeKey === providerTypeKey);
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.credentialSetsJson);
  const inlineSet = buildInlineBasicAuthCredentialSet(config.username, config.password, {
    id: setLabels.inlineId,
    displayName: setLabels.inlineDisplayName,
    priority: 200,
  });
  const textSet = buildBasicAuthCredentialSet(config.accountsText, {
    id: setLabels.textId,
    displayName: setLabels.textDisplayName,
    priority: 180,
  });
  const fileSet = buildBasicAuthCredentialSetFromFile(config.accountsFile, {
    id: setLabels.fileId,
    displayName: setLabels.fileDisplayName,
    priority: 160,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [inlineSet, textSet, fileSet].filter((item): item is CredentialSetDefinition => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.baseUrl ? { apiBase: config.baseUrl } : {}),
    ...(config.domain ? { domain: config.domain } : {}),
    ...Object.fromEntries(
      Object.entries(config.extraMetadata ?? {}).filter(([, value]) => typeof value === "string" && value.trim()),
    ) as Record<string, string>,
  });

  service.saveProviderInstance({
    ...instance,
    status: enabled && formalSets.length > 0 ? "active" : "offline",
    connectionRef: config.baseUrl?.trim() || instance.connectionRef,
    metadata,
    updatedAt: now.toISOString(),
  });
}

function configureGptMailProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  const snapshot = service.getSnapshot();
  const instance = snapshot.instances.find((item) => item.id === "gptmail_shared_default");
  if (!instance) {
    return;
  }

  const configuredSets = parseCredentialSetsJson(config.gptmail.credentialSetsJson);
  const freeTextSet = createValueCredentialSetFromLines(config.gptmail.freeKeysText ?? config.gptmail.keysText, {
    id: "gptmail-free-lines",
    displayName: "GptMail Free Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 190,
  });
  const freeInlineSet = createValueCredentialSetFromLines(config.gptmail.freeApiKey ?? config.gptmail.apiKey, {
    id: "gptmail-free-inline",
    displayName: "Inline GptMail Free Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 200,
  });
  const freeFileSet = createValueCredentialSetFromFile(config.gptmail.freeKeysFile ?? config.gptmail.keysFile, {
    id: "gptmail-free-file",
    displayName: "GptMail Free Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 180,
  });
  const paidTextSet = createValueCredentialSetFromLines(config.gptmail.paidKeysText, {
    id: "gptmail-paid-lines",
    displayName: "GptMail Paid Keys",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 90,
  });
  const paidInlineSet = createValueCredentialSetFromLines(config.gptmail.paidApiKey, {
    id: "gptmail-paid-inline",
    displayName: "Inline GptMail Paid Key",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 100,
  });
  const paidFileSet = createValueCredentialSetFromFile(config.gptmail.paidKeysFile, {
    id: "gptmail-paid-file",
    displayName: "GptMail Paid Keys File",
    useCases: ["generate", "poll"],
    strategy: "round-robin",
    priority: 80,
  });

  const effectiveSets = configuredSets.length > 0
    ? configuredSets
    : [
        freeInlineSet,
        freeTextSet,
        freeFileSet,
        paidInlineSet,
        paidTextSet,
        paidFileSet,
      ].filter((item) => item !== undefined);

  const { formalSets, now } = resolveAndPersistCredentialSets(service, snapshot, instance, effectiveSets);
  const metadata = buildProviderMetadataWithCredentials(instance, formalSets, {
    ...(config.gptmail.baseUrl ? { baseUrl: config.gptmail.baseUrl } : {}),
    ...(config.gptmail.prefix ? { prefix: config.gptmail.prefix } : {}),
    ...(config.gptmail.domain ? { domain: config.gptmail.domain } : {}),
    ...(config.gptmail.keysFile ? { keysFile: config.gptmail.keysFile } : {}),
    ...(config.gptmail.apiKey ? { apiKey: config.gptmail.apiKey } : {}),
  });

  service.saveProviderInstance({
    ...instance,
    metadata,
    updatedAt: now.toISOString(),
  });
}

function configureMoemailProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureApiKeyProviderInstance(
    service,
    "moemail_shared_default",
    "moemail",
    isExternalProviderEnabled(config, "moemail"),
    {
      baseUrl: config.moemail.baseUrl,
      apiKey: config.moemail.apiKey,
      keysFile: config.moemail.keysFile,
      keysText: config.moemail.keysText,
      credentialSetsJson: config.moemail.credentialSetsJson,
      domain: config.moemail.domain,
      extraMetadata: {
        expiryTimeMs: config.moemail.expiryTimeMs != null ? String(config.moemail.expiryTimeMs) : undefined,
        webSessionToken: config.moemail.webSessionToken,
        webCsrfToken: config.moemail.webCsrfToken,
        webCallbackUrl: config.moemail.webCallbackUrl,
        webReferer: config.moemail.webReferer,
      },
    },
    {
      inlineId: "moemail-inline",
      inlineDisplayName: "Inline MoEmail API Key",
      textId: "moemail-lines",
      textDisplayName: "MoEmail API Keys",
      fileId: "moemail-file",
      fileDisplayName: "MoEmail API Keys File",
    },
  );
}

function configureIm215ProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureApiKeyProviderInstance(
    service,
    "im215_shared_default",
    "im215",
    isExternalProviderEnabled(config, "im215"),
    {
      baseUrl: config.im215.baseUrl,
      apiKey: config.im215.apiKey,
      keysFile: config.im215.keysFile,
      keysText: config.im215.keysText,
      credentialSetsJson: config.im215.credentialSetsJson,
      domain: config.im215.domain,
      extraMetadata: {
        autoDomainStrategy: config.im215.autoDomainStrategy,
      },
    },
    {
      inlineId: "im215-inline",
      inlineDisplayName: "Inline 215.im API Key",
      textId: "im215-lines",
      textDisplayName: "215.im API Keys",
      fileId: "im215-file",
      fileDisplayName: "215.im API Keys File",
    },
  );
}

function configureMail2925ProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureBasicAuthProviderInstance(
    service,
    "mail2925_shared_default",
    "mail2925",
    isExternalProviderEnabled(config, "mail2925"),
    {
      baseUrl: config.mail2925.baseUrl,
      username: config.mail2925.account ?? config.mail2925.username,
      password: config.mail2925.password,
      accountsFile: config.mail2925.accountsFile,
      accountsText: config.mail2925.accountsText,
      credentialSetsJson: config.mail2925.credentialSetsJson,
      domain: config.mail2925.domain,
      extraMetadata: {
        folderName: config.mail2925.folderName,
        aliasSeparator: config.mail2925.aliasSeparator,
        aliasSuffixLength: config.mail2925.aliasSuffixLength != null ? String(config.mail2925.aliasSuffixLength) : undefined,
        timeoutSeconds: config.mail2925.timeoutSeconds != null ? String(config.mail2925.timeoutSeconds) : undefined,
      },
    },
    {
      inlineId: "mail2925-inline",
      inlineDisplayName: "Inline 2925 Credentials",
      textId: "mail2925-lines",
      textDisplayName: "2925 Credentials",
      fileId: "mail2925-file",
      fileDisplayName: "2925 Credentials File",
    },
  );
}

async function configureCloudflareTempEmailProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): Promise<void> {
  const request = buildCloudflareTempEmailRegistrationRequest(config);
  if (!request) {
    return;
  }

  await service.registerCloudflareTempEmailRuntime(request);
  reconcileCloudflareTempEmailSharedInstances(service, request, new Date());
}

function buildCloudflareTempEmailRegistrationRequest(
  config: EasyEmailServiceRuntimeConfig,
): RegisterCloudflareTempEmailRuntimeRequest | undefined {
  const baseUrl = config.cloudflareTempEmail.baseUrl?.trim();
  if (!baseUrl) {
    return undefined;
  }

  const inferredDomain = (() => {
    try {
      return new URL(baseUrl).hostname || undefined;
    } catch {
      return undefined;
    }
  })();

  return {
    instanceId: config.cloudflareTempEmail.instanceId,
    templateId: config.cloudflareTempEmail.templateId,
    displayName: config.cloudflareTempEmail.displayName,
    baseUrl,
    customAuth: config.cloudflareTempEmail.apiKey,
    adminAuth: config.cloudflareTempEmail.adminAuth,
    domain: config.cloudflareTempEmail.domain?.trim() || config.cloudflareTempEmail.domains?.[0]?.trim() || inferredDomain,
    domains: config.cloudflareTempEmail.domains,
    randomSubdomainDomains: config.cloudflareTempEmail.randomSubdomainDomains,
    deploymentTarget: config.cloudflareTempEmail.deploymentTarget,
    shared: config.cloudflareTempEmail.shared,
    groupKeys: config.cloudflareTempEmail.groupKeys,
    connectionRef: baseUrl,
  };
}

function reconcileCloudflareTempEmailSharedInstances(
  service: EasyEmailService,
  request: RegisterCloudflareTempEmailRuntimeRequest,
  now: Date,
): void {
  const canonical = resolveCanonicalCloudflareTempEmailSharedInstance(service, request);
  if (!canonical) {
    return;
  }

  const timestamp = now.toISOString();
  const normalizedBaseUrl = normalizeCloudflareTempEmailBaseUrl(request.baseUrl);
  const normalizedDomain = normalizeCloudflareTempEmailDomain(request.domain);

  for (const instance of service.listInstances()) {
    if (
      instance.providerTypeKey !== "cloudflare_temp_email"
      || instance.shared !== true
      || instance.id === canonical.id
      || matchesCloudflareTempEmailSharedInstance(instance, normalizedBaseUrl, normalizedDomain) === false
    ) {
      continue;
    }

    if (instance.status === "offline") {
      continue;
    }

    service.saveProviderInstance({
      ...instance,
      status: "offline",
      updatedAt: timestamp,
    });
  }

  for (const binding of service.listBindings()) {
    if (
      binding.providerTypeKey !== "cloudflare_temp_email"
      || binding.bindingMode !== "shared-instance"
      || binding.instanceId === canonical.id
    ) {
      continue;
    }

    service.saveBinding({
      ...binding,
      instanceId: canonical.id,
      updatedAt: timestamp,
    });
  }
}

function resolveCanonicalCloudflareTempEmailSharedInstance(
  service: EasyEmailService,
  request: RegisterCloudflareTempEmailRuntimeRequest,
): ProviderInstance | undefined {
  const requestedInstanceId = request.instanceId?.trim();
  if (requestedInstanceId) {
    const exact = service.findInstanceById(requestedInstanceId);
    if (exact?.providerTypeKey === "cloudflare_temp_email" && exact.shared) {
      return exact;
    }
  }

  const normalizedBaseUrl = normalizeCloudflareTempEmailBaseUrl(request.baseUrl);
  const normalizedDomain = normalizeCloudflareTempEmailDomain(request.domain);
  const candidates = service.listInstances()
    .filter((instance) => (
      instance.providerTypeKey === "cloudflare_temp_email"
      && instance.shared
      && matchesCloudflareTempEmailSharedInstance(instance, normalizedBaseUrl, normalizedDomain)
    ))
    .sort((left, right) => {
      if (left.status !== right.status) {
        return left.status === "active" ? -1 : 1;
      }
      if (right.healthScore !== left.healthScore) {
        return right.healthScore - left.healthScore;
      }
      if (left.averageLatencyMs !== right.averageLatencyMs) {
        return left.averageLatencyMs - right.averageLatencyMs;
      }
      if (right.updatedAt !== left.updatedAt) {
        return right.updatedAt.localeCompare(left.updatedAt);
      }
      return left.id.localeCompare(right.id);
    });

  return candidates[0];
}

function matchesCloudflareTempEmailSharedInstance(
  instance: ProviderInstance,
  normalizedBaseUrl: string | undefined,
  normalizedDomain: string | undefined,
): boolean {
  if (instance.providerTypeKey !== "cloudflare_temp_email" || instance.shared !== true) {
    return false;
  }

  const instanceBaseUrl = normalizeCloudflareTempEmailBaseUrl(instance.metadata.baseUrl);
  const instanceDomain = normalizeCloudflareTempEmailDomain(instance.metadata.domain);

  if (normalizedBaseUrl && instanceBaseUrl === normalizedBaseUrl) {
    return true;
  }

  if (normalizedDomain && instanceDomain === normalizedDomain) {
    return true;
  }

  return false;
}

function normalizeCloudflareTempEmailBaseUrl(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }

  return normalized.replace(/\/+$/, "").toLowerCase();
}

function normalizeCloudflareTempEmailDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

