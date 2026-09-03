import type { EasyEmailService } from "../service/easy-email-service.js";
import type { EasyEmailServiceRuntimeConfig } from "./config.js";
import {
  configureApiKeyProviderInstance,
  configureBasicAuthProviderInstance,
  configureMetadataOnlyExternalProviderInstance,
} from "./provider-credential-config.js";
import { isExternalProviderEnabled } from "./provider-catalog-config.js";

export function configureMoemailProviderInstance(
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

export function configureTempmailLolProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureMetadataOnlyExternalProviderInstance(
    service,
    "tempmail_lol_shared_default",
    "tempmail-lol",
    isExternalProviderEnabled(config, "tempmail-lol"),
    {
      baseUrl: config.tempmailLol.baseUrl,
    },
  );
}

export function configureTemporamProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureMetadataOnlyExternalProviderInstance(
    service,
    "temporam_shared_default",
    "temporam",
    isExternalProviderEnabled(config, "temporam"),
    {
      baseUrl: config.temporam.baseUrl,
      extraMetadata: {
        apiKey: config.temporam.apiKey,
        preferredDomain: config.temporam.preferredDomain,
      },
    },
  );
}

export function configureM2uProviderInstance(
  service: EasyEmailService,
  config: EasyEmailServiceRuntimeConfig,
): void {
  configureMetadataOnlyExternalProviderInstance(
    service,
    "m2u_shared_default",
    "m2u",
    isExternalProviderEnabled(config, "m2u"),
    {
      baseUrl: config.m2u.baseUrl,
      extraMetadata: {
        preferredDomain: config.m2u.preferredDomain,
        upstreamProxyUrl: config.m2u.upstreamProxyUrl,
        useEasyProxyOnCapacity: config.m2u.useEasyProxyOnCapacity != null ? String(config.m2u.useEasyProxyOnCapacity) : undefined,
        easyProxyBaseUrl: config.m2u.easyProxyBaseUrl,
        easyProxyApiKey: config.m2u.easyProxyApiKey,
        easyProxyRuntimeHost: config.m2u.easyProxyRuntimeHost,
        easyProxyHostId: config.m2u.easyProxyHostId,
        easyProxyRequireDedicatedNode: config.m2u.easyProxyRequireDedicatedNode != null ? String(config.m2u.easyProxyRequireDedicatedNode) : undefined,
        easyProxyMaxAttempts: config.m2u.easyProxyMaxAttempts != null ? String(config.m2u.easyProxyMaxAttempts) : undefined,
        pythonCommand: config.m2u.pythonCommand,
      },
    },
  );
}

export function configureIm215ProviderInstance(
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

export function configureMail2925ProviderInstance(
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
        jwtToken: config.mail2925.jwtToken,
        deviceUid: config.mail2925.deviceUid,
        cookieHeader: config.mail2925.cookieHeader,
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
