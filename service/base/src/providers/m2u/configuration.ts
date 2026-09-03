import type { ProviderInstance } from "../../domain/models.js";
import {
  M2U_BROWSER_USER_AGENTS,
  M2U_DEFAULT_ACCEPT_ENCODING,
  M2U_DEFAULT_ACCEPT_LANGUAGE,
  M2U_DEFAULT_API_BASE,
  M2U_DEFAULT_PROXY_HOST_ID,
  M2U_DEFAULT_PROXY_MAX_ATTEMPTS,
  M2U_DEFAULT_USER_AGENT,
} from "./constants.js";
import {
  parseBooleanMetadata,
  parsePositiveInteger,
  readMetadata,
  readStringLike,
} from "./metadata.js";
import type { M2uConfig } from "./types.js";

export function resolveM2uConfig(instance: ProviderInstance): M2uConfig {
  const env = process.env;
  const configuredUserAgents = [
    ...String(readMetadata(instance, "userAgents") ?? readStringLike(env.M2U_USER_AGENTS) ?? "")
      .split(/[\r\n,;]+/)
      .map((item) => item.trim())
      .filter(Boolean),
  ];
  const userAgents = [...new Set(configuredUserAgents.length > 0 ? configuredUserAgents : [...M2U_BROWSER_USER_AGENTS])];
  const explicitUserAgent = readMetadata(instance, "userAgent");
  const easyProxyBaseUrl = readMetadata(instance, "easyProxyBaseUrl")
    ?? readMetadata(instance, "proxyBaseUrl")
    ?? readStringLike(env.EASY_PROXY_BASE_URL);
  const upstreamProxyUrl = readMetadata(instance, "upstreamProxyUrl")
    ?? readStringLike(env.M2U_UPSTREAM_PROXY_URL);
  const useEasyProxyOnCapacity = parseBooleanMetadata(
    readMetadata(instance, "useEasyProxyOnCapacity")
    ?? readMetadata(instance, "proxyFallbackOnCapacity"),
  )
    ?? parseBooleanMetadata(readStringLike(env.M2U_USE_EASY_PROXY_ON_CAPACITY))
    ?? Boolean(easyProxyBaseUrl || upstreamProxyUrl);

  return {
    apiBase: readMetadata(instance, "apiBase") ?? M2U_DEFAULT_API_BASE,
    userAgent: explicitUserAgent ?? M2U_DEFAULT_USER_AGENT,
    userAgents,
    acceptLanguage: readMetadata(instance, "acceptLanguage") ?? M2U_DEFAULT_ACCEPT_LANGUAGE,
    acceptEncoding: readMetadata(instance, "acceptEncoding") ?? M2U_DEFAULT_ACCEPT_ENCODING,
    preferredDomain: readMetadata(instance, "preferredDomain"),
    upstreamProxyUrl,
    useEasyProxyOnCapacity,
    easyProxyBaseUrl,
    easyProxyApiKey: readMetadata(instance, "easyProxyApiKey") ?? readStringLike(env.EASY_PROXY_API_KEY),
    easyProxyRuntimeHost: readMetadata(instance, "easyProxyRuntimeHost") ?? readStringLike(env.EASY_PROXY_RUNTIME_HOST),
    easyProxyHostId: readMetadata(instance, "easyProxyHostId")
      ?? readStringLike(env.M2U_EASY_PROXY_HOST_ID)
      ?? readStringLike(env.EASY_PROXY_HOST_ID)
      ?? M2U_DEFAULT_PROXY_HOST_ID,
    easyProxyRequireDedicatedNode: parseBooleanMetadata(readMetadata(instance, "easyProxyRequireDedicatedNode"))
      ?? parseBooleanMetadata(readStringLike(env.M2U_EASY_PROXY_REQUIRE_DEDICATED_NODE))
      ?? true,
    easyProxyMaxAttempts: parsePositiveInteger(
      readMetadata(instance, "easyProxyMaxAttempts")
        ?? readStringLike(env.M2U_EASY_PROXY_MAX_ATTEMPTS),
      M2U_DEFAULT_PROXY_MAX_ATTEMPTS,
    ),
    pythonCommand: readMetadata(instance, "pythonCommand")
      ?? readStringLike(env.M2U_PROXY_PYTHON_COMMAND)
      ?? "python",
  };
}
