import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { MailPersistenceDriver } from "../persistence/contracts.js";
import type { MailStrategyModeResolution } from "../domain/models.js";
import {
  normalizeMailBusinessStrategyId,
  parseMailStrategyModeJson,
  resolveMailStrategyMode,
} from "../domain/strategy-mode.js";
import type {
  MailRoutingProfileDescriptor,
  MailRoutingProfileHealthGate,
} from "../domain/models.js";
import { normalizeMailProviderTypeKey } from "../domain/models.js";

export const EASY_EMAIL_DEFAULT_CONFIG_PATH = "/etc/easy-email/config.yaml";
export const EASY_EMAIL_DEFAULT_STATE_DIR = "/var/lib/easy-email";

export interface EasyEmailRuntimeBootstrapEnvironment {
  EASY_EMAIL_CONFIG_PATH?: string;
  EASY_EMAIL_STATE_DIR?: string;
  EASY_EMAIL_RESET_STORE_ON_BOOT?: string;
}

export type EasyEmailServiceRuntimeEnvironment = EasyEmailRuntimeBootstrapEnvironment;

export interface GptMailRuntimeConfig {
  enabledProviders?: string[];
  baseUrl?: string;
  apiKey?: string;
  keysFile?: string;
  keysText?: string;
  freeApiKey?: string;
  freeKeysFile?: string;
  freeKeysText?: string;
  paidApiKey?: string;
  paidKeysFile?: string;
  paidKeysText?: string;
  credentialSetsJson?: string;
  prefix?: string;
  domain?: string;
}

export interface ApiKeyProviderRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  keysFile?: string;
  keysText?: string;
  credentialSetsJson?: string;
  domain?: string;
}

export interface TempmailLolRuntimeConfig {
  baseUrl?: string;
}

export interface M2uRuntimeConfig {
  baseUrl?: string;
  preferredDomain?: string;
  upstreamProxyUrl?: string;
  useEasyProxyOnCapacity?: boolean;
  easyProxyBaseUrl?: string;
  easyProxyApiKey?: string;
  easyProxyRuntimeHost?: string;
  easyProxyHostId?: string;
  easyProxyRequireDedicatedNode?: boolean;
  easyProxyMaxAttempts?: number;
  pythonCommand?: string;
}

export interface BasicAuthProviderRuntimeConfig {
  baseUrl?: string;
  account?: string;
  username?: string;
  password?: string;
  accountsFile?: string;
  accountsText?: string;
  credentialSetsJson?: string;
  domain?: string;
}

export interface MoemailRuntimeConfig extends ApiKeyProviderRuntimeConfig {
  expiryTimeMs?: number;
  webSessionToken?: string;
  webCsrfToken?: string;
  webCallbackUrl?: string;
  webReferer?: string;
}

export interface Im215RuntimeConfig extends ApiKeyProviderRuntimeConfig {
  autoDomainStrategy?: string;
}

export interface Mail2925RuntimeConfig extends BasicAuthProviderRuntimeConfig {
  folderName?: string;
  aliasSeparator?: string;
  aliasSuffixLength?: number;
  timeoutSeconds?: number;
  jwtToken?: string;
  deviceUid?: string;
  cookieHeader?: string;
}

export interface CloudflareTempEmailRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  adminAuth?: string;
  domain?: string;
  domains?: string[];
  randomSubdomainDomains?: string[];
  instanceId?: string;
  displayName?: string;
  templateId?: string;
  deploymentTarget?: string;
  groupKeys?: string[];
  shared?: boolean;
}

export interface DdgAliasProviderRuntimeConfig {
  key: "ddg";
  enabled: boolean;
  apiBaseUrl: string;
  tokens?: string[];
  tokensText?: string;
  tokensFile?: string;
  dailyLimit: number;
  cooldownMs: number;
  stateFilePath: string;
}

export type AliasProviderRuntimeConfig = DdgAliasProviderRuntimeConfig;

export interface AliasEmailRuntimeConfig {
  providers: AliasProviderRuntimeConfig[];
}

export interface EasyEmailServiceRuntimeConfig {
  hostname: string;
  defaultStrategyProfileId?: string;
  defaultStrategyMode?: MailStrategyModeResolution;
  routingProfiles: MailRoutingProfileDescriptor[];
  port: number;
  apiKey: string | undefined;
  enabledProviders?: string[];
  strictProviderMode: boolean;
  maintenance: {
    enabled: boolean;
    intervalMs: number;
    keepRecentCount: number;
    keepRecentSessionCount: number;
    activeProbeEnabled: boolean;
    activeProbeIntervalMs: number;
  };
  persistence: {
    enabled: boolean;
    driver: MailPersistenceDriver;
    filePath: string;
    databasePath: string;
    sqliteHelperScriptPath?: string;
    pythonCommand?: string;
    intervalMs: number;
  };
  gptmail: GptMailRuntimeConfig;
  tempmailLol: TempmailLolRuntimeConfig;
  m2u: M2uRuntimeConfig;
  moemail: MoemailRuntimeConfig;
  im215: Im215RuntimeConfig;
  mail2925: Mail2925RuntimeConfig;
  cloudflareTempEmail: CloudflareTempEmailRuntimeConfig;
  aliasEmail: AliasEmailRuntimeConfig;
}

export interface EasyEmailServiceConfigDocument {
  server?: {
    host?: unknown;
    hostname?: unknown;
    port?: unknown;
    apiKey?: unknown;
  };
  aliasEmail?: {
    providers?: unknown;
  };
  maintenance?: {
    enabled?: unknown;
    intervalMs?: unknown;
    keepRecentCount?: unknown;
    keepRecentSessionCount?: unknown;
    activeProbeEnabled?: unknown;
    activeProbeIntervalMs?: unknown;
  };
  persistence?: {
    enabled?: unknown;
    driver?: unknown;
    filePath?: unknown;
    databasePath?: unknown;
    sqliteHelperScriptPath?: unknown;
    pythonCommand?: unknown;
    intervalMs?: unknown;
  };
  strategy?: {
    defaultStrategyProfileId?: unknown;
    strategyModeJson?: unknown;
    providerStrategyModeId?: unknown;
    providerStrategy?: unknown;
    providerSelections?: unknown;
    providers?: unknown;
    mode?: unknown;
    strictProviderMode?: unknown;
    routingProfiles?: unknown;
  };
  providers?: {
    enabledProviders?: unknown;
    gptmail?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      keysFile?: unknown;
      keysText?: unknown;
      freeApiKey?: unknown;
      freeKeysFile?: unknown;
      freeKeysText?: unknown;
      paidApiKey?: unknown;
      paidKeysFile?: unknown;
      paidKeysText?: unknown;
      credentialSetsJson?: unknown;
      prefix?: unknown;
      domain?: unknown;
    };
    tempmailLol?: {
      baseUrl?: unknown;
    };
    m2u?: {
      baseUrl?: unknown;
      preferredDomain?: unknown;
      upstreamProxyUrl?: unknown;
      useEasyProxyOnCapacity?: unknown;
      easyProxyBaseUrl?: unknown;
      easyProxyApiKey?: unknown;
      easyProxyRuntimeHost?: unknown;
      easyProxyHostId?: unknown;
      easyProxyRequireDedicatedNode?: unknown;
      easyProxyMaxAttempts?: unknown;
      pythonCommand?: unknown;
    };
    moemail?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      keysFile?: unknown;
      keysText?: unknown;
      credentialSetsJson?: unknown;
      domain?: unknown;
      expiryTimeMs?: unknown;
      webSessionToken?: unknown;
      webCsrfToken?: unknown;
      webCallbackUrl?: unknown;
      webReferer?: unknown;
    };
    im215?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      keysFile?: unknown;
      keysText?: unknown;
      credentialSetsJson?: unknown;
      domain?: unknown;
      autoDomainStrategy?: unknown;
    };
    mail2925?: {
      baseUrl?: unknown;
      account?: unknown;
      username?: unknown;
      password?: unknown;
      accountsFile?: unknown;
      accountsText?: unknown;
      credentialSetsJson?: unknown;
      domain?: unknown;
      folderName?: unknown;
      aliasSeparator?: unknown;
      aliasSuffixLength?: unknown;
      timeoutSeconds?: unknown;
      jwtToken?: unknown;
      deviceUid?: unknown;
      cookieHeader?: unknown;
    };
    cloudflare_temp_email?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      adminAuth?: unknown;
      domain?: unknown;
      domains?: unknown;
      randomSubdomainDomains?: unknown;
      instanceId?: unknown;
      displayName?: unknown;
      templateId?: unknown;
      deploymentTarget?: unknown;
      groupKeys?: unknown;
      shared?: unknown;
    };
  };
}

export interface ParseEasyEmailServiceRuntimeConfigOptions {
  stateDir?: string;
}

export interface LoadEasyEmailServiceRuntimeConfigOptions {
  configPath: string;
  stateDir?: string;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseEmbeddedLines(value: unknown): string | undefined {
  const text = asNonEmptyString(value);
  return text ? text.replace(/\\n/g, "\n") : undefined;
}

function parseStringList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const items = value
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }

  const text = asNonEmptyString(value);
  if (!text) {
    return undefined;
  }

  const items = text.split(",").map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
  }

  return fallback;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return parseBoolean(value, false);
}

function parsePositiveInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function parseOptionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  return parsePositiveInteger(value, 0, label);
}

function parseOptionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number.parseFloat(String(value));
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return parsed;
}

function parsePersistenceDriver(value: unknown): MailPersistenceDriver {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized || normalized === "file") {
    return "file";
  }
  if (normalized === "database" || normalized === "db") {
    return "database";
  }
  if (normalized === "sqlite") {
    return "sqlite";
  }

  throw new Error("persistence.driver must be one of: file, sqlite, database.");
}

function resolveDefaultStatePath(stateDir: string, fileName: string): string {
  return resolve(stateDir, fileName);
}

function resolvePathWithinStateDir(stateDir: string, value: unknown, fallbackName: string): string {
  const configured = asNonEmptyString(value);
  if (!configured) {
    return resolveDefaultStatePath(stateDir, fallbackName);
  }

  return isAbsolute(configured)
    ? configured
    : resolve(stateDir, configured);
}

function parseStrategyModeJson(raw: unknown): MailStrategyModeResolution | undefined {
  if (typeof raw === "string") {
    return parseMailStrategyModeJson(raw);
  }

  if (raw && typeof raw === "object" && Array.isArray(raw) === false) {
    return parseMailStrategyModeJson(JSON.stringify(raw));
  }

  return undefined;
}

function parseAliasProviderConfigs(value: unknown, stateDir: string): AliasProviderRuntimeConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const providers: AliasProviderRuntimeConfig[] = [];
  for (const item of value) {
    const record = asObject(item);
    const key = asNonEmptyString(record.key)?.toLowerCase();
    if (!key) {
      continue;
    }

    if (key !== "ddg") {
      throw new Error(`aliasEmail.providers[].key '${key}' is not supported.`);
    }

    providers.push({
      key: "ddg",
      enabled: parseBoolean(record.enabled, true),
      apiBaseUrl: asNonEmptyString(record.apiBaseUrl) ?? "https://quack.duckduckgo.com",
      tokens: parseStringList(record.tokens),
      tokensText: parseEmbeddedLines(record.tokensText),
      tokensFile: asNonEmptyString(record.tokensFile),
      dailyLimit: parsePositiveInteger(record.dailyLimit, 150, "aliasEmail.providers[].dailyLimit"),
      cooldownMs: parsePositiveInteger(record.cooldownMs, 24 * 60 * 60 * 1000, "aliasEmail.providers[].cooldownMs"),
      stateFilePath: resolvePathWithinStateDir(stateDir, record.stateFilePath, "state/ddg-alias-key-pool.json"),
    });
  }

  return providers;
}

function parseRoutingProfileHealthGate(value: unknown): MailRoutingProfileHealthGate | undefined {
  const record = asObject(value);
  const minimumHealthScore = parseOptionalNonNegativeNumber(
    record.minimumHealthScore,
    "strategy.routingProfiles[].healthGate.minimumHealthScore",
  );
  const maxConsecutiveFailures = parseOptionalPositiveInteger(
    record.maxConsecutiveFailures,
    "strategy.routingProfiles[].healthGate.maxConsecutiveFailures",
  );
  const recentFailureWindowMs = parseOptionalPositiveInteger(
    record.recentFailureWindowMs,
    "strategy.routingProfiles[].healthGate.recentFailureWindowMs",
  );
  const recentFailurePenalty = parseOptionalNonNegativeNumber(
    record.recentFailurePenalty,
    "strategy.routingProfiles[].healthGate.recentFailurePenalty",
  );

  if (
    minimumHealthScore === undefined
    && maxConsecutiveFailures === undefined
    && recentFailureWindowMs === undefined
    && recentFailurePenalty === undefined
  ) {
    return undefined;
  }

  return {
    minimumHealthScore,
    maxConsecutiveFailures,
    recentFailureWindowMs,
    recentFailurePenalty,
  };
}

function parseRoutingProfiles(value: unknown): MailRoutingProfileDescriptor[] {
  let rawProfiles: unknown[] | undefined;
  if (Array.isArray(value)) {
    rawProfiles = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        rawProfiles = parsed;
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`strategy.routingProfiles must be a YAML list or JSON array string: ${reason}`);
    }
  }

  if (!rawProfiles) {
    return [];
  }

  const profiles: MailRoutingProfileDescriptor[] = [];
  for (const item of rawProfiles) {
    const record = asObject(item);
    const id = asNonEmptyString(record.id)?.toLowerCase();
    if (!id) {
      continue;
    }

    const providerSelections = (parseStringList(record.providerSelections) ?? [])
      .map((entry) => normalizeMailProviderTypeKey(entry))
      .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

    profiles.push({
      id,
      displayName: asNonEmptyString(record.displayName) ?? id,
      description: asNonEmptyString(record.description) ?? "",
      providerStrategyModeId: normalizeMailBusinessStrategyId(asNonEmptyString(record.providerStrategyModeId)),
      providerSelections: providerSelections.length > 0 ? providerSelections : undefined,
      strategyProfileId: asNonEmptyString(record.strategyProfileId),
      healthGate: parseRoutingProfileHealthGate(record.healthGate),
    });
  }

  return profiles;
}

export function resolveEasyEmailConfigPath(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): string {
  return asNonEmptyString(env.EASY_EMAIL_CONFIG_PATH) ?? EASY_EMAIL_DEFAULT_CONFIG_PATH;
}

export function resolveEasyEmailStateDir(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): string {
  return asNonEmptyString(env.EASY_EMAIL_STATE_DIR) ?? EASY_EMAIL_DEFAULT_STATE_DIR;
}

export function shouldResetEasyEmailStoreOnBoot(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): boolean {
  return parseBoolean(env.EASY_EMAIL_RESET_STORE_ON_BOOT, false);
}

export function parseEasyEmailServiceRuntimeConfig(
  document: EasyEmailServiceConfigDocument = {},
  options: ParseEasyEmailServiceRuntimeConfigOptions = {},
): EasyEmailServiceRuntimeConfig {
  const server = asObject(document.server);
  const aliasEmail = asObject(document.aliasEmail);
  const maintenance = asObject(document.maintenance);
  const persistence = asObject(document.persistence);
  const strategy = asObject(document.strategy);
  const providers = asObject(document.providers);
  const gptmail = asObject(providers.gptmail);
  const tempmailLol = asObject(
    (providers as Record<string, unknown>).tempmailLol ?? (providers as Record<string, unknown>)["tempmail-lol"],
  );
  const m2u = asObject(providers.m2u);
  const moemail = asObject(providers.moemail);
  const im215 = asObject(providers.im215);
  const mail2925 = asObject(providers.mail2925);
  const cloudflareTempEmail = asObject(
    providers.cloudflareTempEmail ?? (providers as Record<string, unknown>).cloudflare_temp_email,
  );

  const stateDir = asNonEmptyString(options.stateDir) ?? EASY_EMAIL_DEFAULT_STATE_DIR;
  const defaultStrategyProfileId = asNonEmptyString(strategy.defaultStrategyProfileId);
  const routingProfiles = parseRoutingProfiles(strategy.routingProfiles);

  const providerSelections = parseStringList(strategy.providerSelections)
    ?? parseStringList(strategy.providers)
    ?? parseStringList(providers.enabledProviders)
    ?? deriveMailSelectionsFromServiceMode(asNonEmptyString(strategy.mode));

  const defaultStrategyMode = parseStrategyModeJson(strategy.strategyModeJson)
    ?? resolveMailStrategyMode({
      modeId: asNonEmptyString(strategy.providerStrategyModeId) ?? asNonEmptyString(strategy.providerStrategy),
      providerSelections,
      requestedProfileId: defaultStrategyProfileId,
    });

  return {
    hostname: asNonEmptyString(server.hostname) ?? asNonEmptyString(server.host) ?? "0.0.0.0",
    defaultStrategyProfileId,
    defaultStrategyMode,
    routingProfiles,
    port: parsePositiveInteger(server.port, 8080, "server.port"),
    apiKey: asNonEmptyString(server.apiKey),
    enabledProviders: parseStringList(providers.enabledProviders),
    aliasEmail: {
      providers: parseAliasProviderConfigs(aliasEmail.providers, stateDir),
    },
    strictProviderMode: parseBoolean(strategy.strictProviderMode, false),
    maintenance: {
      enabled: parseBoolean(maintenance.enabled, true),
      intervalMs: parsePositiveInteger(maintenance.intervalMs, 30000, "maintenance.intervalMs"),
      keepRecentCount: parsePositiveInteger(maintenance.keepRecentCount, 5, "maintenance.keepRecentCount"),
      keepRecentSessionCount: parsePositiveInteger(
        maintenance.keepRecentSessionCount,
        5000,
        "maintenance.keepRecentSessionCount",
      ),
      activeProbeEnabled: parseBoolean(maintenance.activeProbeEnabled, true),
      activeProbeIntervalMs: parsePositiveInteger(
        maintenance.activeProbeIntervalMs,
        30000,
        "maintenance.activeProbeIntervalMs",
      ),
    },
    persistence: {
      enabled: parseBoolean(persistence.enabled, true),
      driver: parsePersistenceDriver(persistence.driver),
      filePath: resolvePathWithinStateDir(stateDir, persistence.filePath, "state/easy-email-state.json"),
      databasePath: resolvePathWithinStateDir(stateDir, persistence.databasePath, "state/easy-email-state.sqlite3"),
      sqliteHelperScriptPath: asNonEmptyString(persistence.sqliteHelperScriptPath),
      pythonCommand: asNonEmptyString(persistence.pythonCommand),
      intervalMs: parsePositiveInteger(persistence.intervalMs, 60000, "persistence.intervalMs"),
    },
    gptmail: {
      enabledProviders: parseStringList(providers.enabledProviders),
      baseUrl: asNonEmptyString(gptmail.baseUrl),
      apiKey: asNonEmptyString(gptmail.apiKey),
      keysFile: asNonEmptyString(gptmail.keysFile),
      keysText: parseEmbeddedLines(gptmail.keysText),
      freeApiKey: asNonEmptyString(gptmail.freeApiKey),
      freeKeysFile: asNonEmptyString(gptmail.freeKeysFile),
      freeKeysText: parseEmbeddedLines(gptmail.freeKeysText),
      paidApiKey: asNonEmptyString(gptmail.paidApiKey),
      paidKeysFile: asNonEmptyString(gptmail.paidKeysFile),
      paidKeysText: parseEmbeddedLines(gptmail.paidKeysText),
      credentialSetsJson: asNonEmptyString(gptmail.credentialSetsJson),
      prefix: asNonEmptyString(gptmail.prefix),
      domain: asNonEmptyString(gptmail.domain),
    },
    tempmailLol: {
      baseUrl: asNonEmptyString(tempmailLol.baseUrl),
    },
    m2u: {
      baseUrl: asNonEmptyString(m2u.baseUrl),
      preferredDomain: asNonEmptyString(m2u.preferredDomain),
      upstreamProxyUrl: asNonEmptyString(m2u.upstreamProxyUrl),
      useEasyProxyOnCapacity: parseOptionalBoolean(m2u.useEasyProxyOnCapacity),
      easyProxyBaseUrl: asNonEmptyString(m2u.easyProxyBaseUrl),
      easyProxyApiKey: asNonEmptyString(m2u.easyProxyApiKey),
      easyProxyRuntimeHost: asNonEmptyString(m2u.easyProxyRuntimeHost),
      easyProxyHostId: asNonEmptyString(m2u.easyProxyHostId),
      easyProxyRequireDedicatedNode: parseOptionalBoolean(m2u.easyProxyRequireDedicatedNode),
      easyProxyMaxAttempts: parseOptionalPositiveInteger(m2u.easyProxyMaxAttempts, "providers.m2u.easyProxyMaxAttempts"),
      pythonCommand: asNonEmptyString(m2u.pythonCommand),
    },
    moemail: {
      baseUrl: asNonEmptyString(moemail.baseUrl),
      apiKey: asNonEmptyString(moemail.apiKey),
      keysFile: asNonEmptyString(moemail.keysFile),
      keysText: parseEmbeddedLines(moemail.keysText),
      credentialSetsJson: asNonEmptyString(moemail.credentialSetsJson),
      domain: asNonEmptyString(moemail.domain),
      expiryTimeMs: parseOptionalPositiveInteger(moemail.expiryTimeMs, "providers.moemail.expiryTimeMs"),
      webSessionToken: asNonEmptyString(moemail.webSessionToken),
      webCsrfToken: asNonEmptyString(moemail.webCsrfToken),
      webCallbackUrl: asNonEmptyString(moemail.webCallbackUrl),
      webReferer: asNonEmptyString(moemail.webReferer),
    },
    im215: {
      baseUrl: asNonEmptyString(im215.baseUrl),
      apiKey: asNonEmptyString(im215.apiKey),
      keysFile: asNonEmptyString(im215.keysFile),
      keysText: parseEmbeddedLines(im215.keysText),
      credentialSetsJson: asNonEmptyString(im215.credentialSetsJson),
      domain: asNonEmptyString(im215.domain),
      autoDomainStrategy: asNonEmptyString(im215.autoDomainStrategy),
    },
    mail2925: {
      baseUrl: asNonEmptyString(mail2925.baseUrl),
      account: asNonEmptyString(mail2925.account),
      username: asNonEmptyString(mail2925.username),
      password: asNonEmptyString(mail2925.password),
      accountsFile: asNonEmptyString(mail2925.accountsFile),
      accountsText: parseEmbeddedLines(mail2925.accountsText),
      credentialSetsJson: asNonEmptyString(mail2925.credentialSetsJson),
      domain: asNonEmptyString(mail2925.domain),
      folderName: asNonEmptyString(mail2925.folderName),
      aliasSeparator: asNonEmptyString(mail2925.aliasSeparator),
      aliasSuffixLength: parseOptionalPositiveInteger(mail2925.aliasSuffixLength, "providers.mail2925.aliasSuffixLength"),
      timeoutSeconds: parseOptionalPositiveInteger(mail2925.timeoutSeconds, "providers.mail2925.timeoutSeconds"),
      jwtToken: asNonEmptyString(mail2925.jwtToken),
      deviceUid: asNonEmptyString(mail2925.deviceUid),
      cookieHeader: asNonEmptyString(mail2925.cookieHeader),
    },
    cloudflareTempEmail: {
      baseUrl: asNonEmptyString(cloudflareTempEmail.baseUrl),
      apiKey: asNonEmptyString(cloudflareTempEmail.apiKey),
      adminAuth: asNonEmptyString(cloudflareTempEmail.adminAuth),
      domain: asNonEmptyString(cloudflareTempEmail.domain),
      domains: parseStringList(cloudflareTempEmail.domains),
      randomSubdomainDomains: parseStringList(cloudflareTempEmail.randomSubdomainDomains),
      instanceId: asNonEmptyString(cloudflareTempEmail.instanceId),
      displayName: asNonEmptyString(cloudflareTempEmail.displayName),
      templateId: asNonEmptyString(cloudflareTempEmail.templateId),
      deploymentTarget: asNonEmptyString(cloudflareTempEmail.deploymentTarget),
      groupKeys: parseStringList(cloudflareTempEmail.groupKeys),
      shared: parseOptionalBoolean(cloudflareTempEmail.shared),
    },
  };
}

export async function loadEasyEmailServiceRuntimeConfigFromFile(
  options: LoadEasyEmailServiceRuntimeConfigOptions,
): Promise<EasyEmailServiceRuntimeConfig> {
  const raw = await readFile(options.configPath, "utf8");
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse EasyEmail config YAML at ${options.configPath}: ${reason}`);
  }

  if (parsed == null) {
    return parseEasyEmailServiceRuntimeConfig({}, { stateDir: options.stateDir });
  }

  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`EasyEmail config YAML at ${options.configPath} must be a mapping object.`);
  }

  return parseEasyEmailServiceRuntimeConfig(parsed as EasyEmailServiceConfigDocument, {
    stateDir: options.stateDir,
  });
}

export async function loadEasyEmailServiceRuntimeConfigFromEnvironment(
  env: EasyEmailRuntimeBootstrapEnvironment = process.env,
): Promise<EasyEmailServiceRuntimeConfig> {
  const configPath = resolveEasyEmailConfigPath(env);
  const stateDir = resolveEasyEmailStateDir(env);

  return loadEasyEmailServiceRuntimeConfigFromFile({
    configPath,
    stateDir,
  });
}

function deriveMailSelectionsFromServiceMode(value: string | undefined): string[] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === "cloudflare_temp_email") {
    return ["cloudflare_temp_email"];
  }

  if (normalized === "external-api") {
    return ["mailtm", "m2u", "mail2925", "guerrillamail", "moemail", "im215", "duckmail", "tempmail-lol", "etempmail", "gptmail"];
  }

  return undefined;
}
