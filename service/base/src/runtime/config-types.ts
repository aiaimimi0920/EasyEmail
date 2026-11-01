import type { CloudflareTempEmailSendTransport } from "../domain/cloudflare-send-policy.js";
import type {
  MailRoutingProfileDescriptor,
  MailStrategyModeResolution,
} from "../domain/models.js";
import type { MailPersistenceDriver } from "../persistence/contracts.js";

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

export interface TemporamRuntimeConfig {
  baseUrl?: string;
  apiKey?: string;
  preferredDomain?: string;
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
  sendTransport?: CloudflareTempEmailSendTransport;
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
  corsOrigins?: string[];
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
  temporam: TemporamRuntimeConfig;
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
    corsOrigins?: unknown;
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
    temporam?: {
      baseUrl?: unknown;
      apiKey?: unknown;
      key?: unknown;
      preferredDomain?: unknown;
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
      sendTransport?: unknown;
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
