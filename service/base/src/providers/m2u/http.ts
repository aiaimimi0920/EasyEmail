declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import * as childProcess from "node:child_process";
import { fetchProviderResource } from "../http-policy.js";
import {
  M2U_DEFAULT_PROXY_HELPER_TIMEOUT_MS,
  M2U_DEFAULT_PROXY_MAX_ATTEMPTS,
  M2U_PROXY_FALLBACK_PATHS,
} from "./constants.js";
import {
  classifyM2uError,
  classifyM2uResponse,
  hasM2uBodyError,
} from "./failure.js";
import { M2U_PROXY_HELPER_SCRIPT } from "./proxy-helper-script.js";
import type { M2uConfig, M2uProxyHelperResult, RequestJsonOptions } from "./types.js";

type ExecFileFunction = typeof childProcess.execFile;

let m2uExecFile: ExecFileFunction = childProcess.execFile;
const m2uKnownGoodProxyUrls = new Map<string, string>();

function buildRequestHeaders(
  config: M2uConfig,
  options: RequestJsonOptions,
  userAgentOverride?: string,
): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": resolveRequestUserAgent(config, userAgentOverride),
    "Accept-Language": config.acceptLanguage,
    "Accept-Encoding": config.acceptEncoding,
    ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
  };
}

function resolveRequestUserAgent(config: M2uConfig, userAgentOverride?: string): string {
  const explicitOverride = userAgentOverride?.trim();
  if (explicitOverride) {
    return explicitOverride;
  }

  const pool = Array.isArray(config.userAgents)
    ? config.userAgents.map((item) => item.trim()).filter(Boolean)
    : [];
  if (pool.length > 0) {
    const index = Math.floor(Math.random() * pool.length);
    return pool[index] || config.userAgent;
  }

  return config.userAgent;
}

function shouldAttemptProxyFallback(config: M2uConfig, method: string, path: string): boolean {
  const normalizedPath = path.trim();
  if (!M2U_PROXY_FALLBACK_PATHS.has(normalizedPath)) {
    return false;
  }

  const explicitProxyUrl = config.upstreamProxyUrl?.trim();
  if (explicitProxyUrl) {
    return true;
  }

  return Boolean(
    config.useEasyProxyOnCapacity
    && config.easyProxyBaseUrl?.trim(),
  );
}

function shouldRetryViaProxyFromError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const classification = classifyM2uError(message);
  return classification === "capacity" || classification === "transient";
}

function shouldPersistWorkingProxy(result: { status: number; body: unknown }): boolean {
  if (result.status < 200 || result.status >= 300) {
    return false;
  }
  return hasM2uBodyError(result.body) === false;
}

function buildProxyCacheKey(config: M2uConfig): string {
  return [
    config.apiBase.replace(/\/$/, ""),
    config.easyProxyBaseUrl?.trim() || "",
    config.easyProxyRuntimeHost?.trim() || "",
    config.easyProxyApiKey?.trim() ? "auth" : "anon",
  ].join("|");
}

async function requestJsonDirect(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
  userAgentOverride?: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetchProviderResource(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: buildRequestHeaders(config, options, userAgentOverride),
    body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
  });

  const text = await response.text();
  if (!text) {
    return {
      status: response.status,
      body: {},
    };
  }

  try {
    return {
      status: response.status,
      body: JSON.parse(text),
    };
  } catch {
    return {
      status: response.status,
      body: text,
    };
  }
}

function execPythonProxyHelper(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions,
  excludedProxyUrls: string[],
  proxyUrlOverride?: string,
): Promise<M2uProxyHelperResult> {
  const args = [
    "-c",
    M2U_PROXY_HELPER_SCRIPT,
    config.apiBase.replace(/\/$/, ""),
    method,
    path,
    JSON.stringify(buildRequestHeaders(config, options)),
    options.jsonBody ? JSON.stringify(options.jsonBody) : "",
    JSON.stringify({
      upstreamProxyUrl: proxyUrlOverride?.trim() || config.upstreamProxyUrl?.trim() || "",
      easyProxyBaseUrl: config.easyProxyBaseUrl?.trim() || "",
      easyProxyApiKey: config.easyProxyApiKey?.trim() || "",
      easyProxyRuntimeHost: config.easyProxyRuntimeHost?.trim() || "",
      easyProxyHostId: config.easyProxyHostId?.trim() || "",
      easyProxyRequireDedicatedNode: Boolean(config.easyProxyRequireDedicatedNode),
      excludedProxyUrls,
    }),
  ];

  return new Promise((resolve, reject) => {
    m2uExecFile(
      config.pythonCommand?.trim() || "python",
      args,
      { timeout: M2U_DEFAULT_PROXY_HELPER_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr?.trim() || stdout?.trim() || error.message;
          reject(new Error(`M2U_TRANSIENT_FAILURE: m2u proxy helper failed: ${detail}`));
          return;
        }

        const raw = stdout.trim();
        if (!raw) {
          reject(new Error("M2U_PROVIDER_FAILURE: m2u proxy helper returned empty output."));
          return;
        }

        try {
          resolve(JSON.parse(raw) as M2uProxyHelperResult);
        } catch {
          reject(new Error(`M2U_PROVIDER_FAILURE: Failed to parse m2u proxy helper output: ${raw.slice(0, 300)}`));
        }
      },
    );
  });
}

async function requestJsonViaProxyFallback(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  const maxAttempts = Math.max(
    1,
    config.upstreamProxyUrl?.trim()
      ? 1
      : (config.easyProxyMaxAttempts ?? M2U_DEFAULT_PROXY_MAX_ATTEMPTS),
  );
  const excludedProxyUrls = new Set<string>();
  const cacheKey = buildProxyCacheKey(config);
  const cachedProxyUrl = config.upstreamProxyUrl?.trim()
    ? undefined
    : m2uKnownGoodProxyUrls.get(cacheKey);
  let lastResult: { status: number; body: unknown } | undefined;
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const proxyUrlOverride = attempt === 0 ? cachedProxyUrl : undefined;
    const result = await execPythonProxyHelper(
      config,
      method,
      path,
      options,
      [...excludedProxyUrls],
      proxyUrlOverride,
    );

    const proxyUrl = result.proxyUrl?.trim();
    if (proxyUrl) {
      excludedProxyUrls.add(proxyUrl.toLowerCase());
    }

    if (result.helperError?.trim()) {
      const helperError = new Error(`M2U_TRANSIENT_FAILURE: m2u proxy helper request failed: ${result.helperError.trim()}`);
      lastError = helperError;
      if (proxyUrlOverride) {
        m2uKnownGoodProxyUrls.delete(cacheKey);
      }
      if (attempt + 1 < maxAttempts && shouldRetryViaProxyFromError(helperError)) {
        continue;
      }
      throw helperError;
    }

    if (typeof result.status !== "number") {
      lastError = new Error("M2U_PROVIDER_FAILURE: m2u proxy helper returned no status.");
      if (attempt + 1 < maxAttempts) {
        continue;
      }
      throw lastError;
    }

    lastResult = {
      status: result.status,
      body: result.body ?? {},
    };
    if (proxyUrl && shouldPersistWorkingProxy(lastResult)) {
      m2uKnownGoodProxyUrls.set(cacheKey, proxyUrl);
    } else if (proxyUrlOverride && (classifyM2uResponse(lastResult.status, lastResult.body, "proxyFallback") !== "provider")) {
      m2uKnownGoodProxyUrls.delete(cacheKey);
    }
    const classification = classifyM2uResponse(lastResult.status, lastResult.body, "proxyFallback");
    const shouldRetry = (
      (classification === "capacity" || classification === "transient")
      && attempt + 1 < maxAttempts
      && !config.upstreamProxyUrl?.trim()
    );
    if (shouldRetry) {
      continue;
    }
    return lastResult;
  }

  if (lastResult) {
    return lastResult;
  }
  throw lastError ?? new Error("M2U_PROVIDER_FAILURE: m2u proxy fallback exhausted with no result.");
}

export async function requestJson(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  try {
    let direct = await requestJsonDirect(config, method, path, options);
    const retryableViaAlternateUa = (
      direct
      && !config.upstreamProxyUrl?.trim()
      && Array.isArray(config.userAgents)
      && config.userAgents.length > 1
      && (classifyM2uResponse(direct.status, direct.body, "direct") === "capacity")
    );
    if (retryableViaAlternateUa) {
      for (const candidateUa of config.userAgents.slice(1)) {
        direct = await requestJsonDirect(config, method, path, options, candidateUa);
        if (classifyM2uResponse(direct.status, direct.body, "direct") !== "capacity") {
          break;
        }
      }
    }
    if (
      shouldAttemptProxyFallback(config, method, path)
      && (
        hasM2uBodyError(direct.body)
        || direct.status === 429
        || direct.status >= 500
      )
    ) {
      const classification = classifyM2uResponse(direct.status, direct.body, "direct");
      if (classification === "capacity" || classification === "transient") {
        return await requestJsonViaProxyFallback(config, method, path, options);
      }
    }
    return direct;
  } catch (error) {
    if (shouldAttemptProxyFallback(config, method, path) && shouldRetryViaProxyFromError(error)) {
      return await requestJsonViaProxyFallback(config, method, path, options);
    }
    throw error;
  }
}

export function setM2uExecFileForTesting(execFileImpl: ExecFileFunction | undefined): void {
  m2uExecFile = execFileImpl ?? childProcess.execFile;
}
