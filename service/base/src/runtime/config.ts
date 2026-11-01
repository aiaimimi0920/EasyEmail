import { readFile } from "node:fs/promises";
import { parseCloudflareSendTransport } from "../domain/cloudflare-send-policy.js";
import { parse as parseYaml } from "yaml";
import type {
  EasyEmailRuntimeBootstrapEnvironment,
  EasyEmailServiceConfigDocument,
  EasyEmailServiceRuntimeConfig,
  LoadEasyEmailServiceRuntimeConfigOptions,
  ParseEasyEmailServiceRuntimeConfigOptions,
} from "./config-types.js";
import {
  asNonEmptyString,
  asObject,
  deriveMailSelectionsFromServiceMode,
  parseAliasProviderConfigs,
  parseBoolean,
  parseEmbeddedLines,
  parseOptionalBoolean,
  parseOptionalPositiveInteger,
  parsePersistenceDriver,
  parsePositiveInteger,
  parseRoutingProfiles,
  parseStrategyModeJson,
  parseStringList,
  resolvePathWithinStateDir,
} from "./config-parsers.js";
import { resolveMailStrategyMode } from "../domain/strategy-mode.js";

export type * from "./config-types.js";

export const EASY_EMAIL_DEFAULT_CONFIG_PATH = "/etc/easy-email/config.yaml";
export const EASY_EMAIL_DEFAULT_STATE_DIR = "/var/lib/easy-email";

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
  const temporam = asObject(providers.temporam);
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
    hostname: asNonEmptyString(server.hostname) ?? asNonEmptyString(server.host) ?? "127.0.0.1",
    defaultStrategyProfileId,
    defaultStrategyMode,
    routingProfiles,
    port: parsePositiveInteger(server.port, 8080, "server.port"),
    apiKey: asNonEmptyString(server.apiKey),
    corsOrigins: parseStringList(server.corsOrigins),
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
    temporam: {
      baseUrl: asNonEmptyString(temporam.baseUrl),
      apiKey: asNonEmptyString(temporam.apiKey ?? temporam.key),
      preferredDomain: asNonEmptyString(temporam.preferredDomain),
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
      sendTransport: parseCloudflareSendTransport(cloudflareTempEmail.sendTransport),
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
