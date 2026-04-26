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
import type { ObservedMessage, ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";

export interface M2uConfig {
  apiBase: string;
  userAgent: string;
  acceptLanguage: string;
  acceptEncoding: string;
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

export interface M2uMailboxCredentials {
  email: string;
  token: string;
  viewToken: string;
  mailboxId?: string;
  expiresAt?: string;
}

interface RequestJsonOptions {
  jsonBody?: Record<string, unknown>;
}

interface M2uProxyHelperResult {
  status?: number;
  body?: unknown;
  proxyUrl?: string;
  proxyMetadata?: Record<string, unknown>;
  helperError?: string;
}

type ExecFileFunction = typeof childProcess.execFile;

const M2U_DEFAULT_API_BASE = "https://api.m2u.io";
const M2U_DEFAULT_USER_AGENT = "EasyEmailM2U/1.0";
const M2U_DEFAULT_ACCEPT_LANGUAGE = "zh-CN,zh;q=0.9";
const M2U_DEFAULT_ACCEPT_ENCODING = "identity";
const M2U_DEFAULT_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS = 900;
const M2U_DOMAIN_MATCH_CONFIDENCE_TARGET = 0.97;
const M2U_DOMAIN_MATCH_MAX_ATTEMPTS = 20;
const M2U_DEFAULT_PROXY_MAX_ATTEMPTS = 10;
const M2U_DEFAULT_PROXY_HELPER_TIMEOUT_MS = 45_000;
const M2U_DEFAULT_PROXY_HOST_ID = "easy-email-service:m2u";
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2})/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|daily_limit_exceeded|rate_limited)/i;
const M2U_PROXY_FALLBACK_PATHS = new Set<string>([
  "/v1/domains",
  "/v1/mailboxes/auto",
  "/v1/mailboxes/custom",
]);
const M2U_PROXY_HELPER_SCRIPT = `
import json
import ipaddress
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

base_url = str(sys.argv[1]).strip()
method = str(sys.argv[2]).strip().upper() or "GET"
path = str(sys.argv[3]).strip()
headers = json.loads(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].strip() else {}
body = json.loads(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].strip() else None
proxy_cfg = json.loads(sys.argv[6]) if len(sys.argv) > 6 and sys.argv[6].strip() else {}

def read_json_response(opener, req):
    with opener.open(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

def build_management_opener(api_base):
    parsed = urllib.parse.urlsplit(str(api_base or "").strip())
    host = str(parsed.hostname or "").strip()
    should_bypass_proxy = host in ("127.0.0.1", "localhost", "::1", "0.0.0.0", "easy-proxy-service")
    if not should_bypass_proxy and host:
        try:
            ip = ipaddress.ip_address(host)
            should_bypass_proxy = bool(ip.is_loopback or ip.is_private or ip.is_link_local)
        except ValueError:
            should_bypass_proxy = False
    if should_bypass_proxy:
        return urllib.request.build_opener(urllib.request.ProxyHandler({}))
    return urllib.request.build_opener()

def api_request(method_name, api_base, api_key, path_value):
    effective_base = str(api_base or "").rstrip("/")
    opener = build_management_opener(effective_base)
    headers_value = {"Content-Type": "application/json"}
    if str(api_key or "").strip():
        headers_value["Authorization"] = "Bearer " + str(api_key).strip()
    request = urllib.request.Request(
        effective_base + path_value,
        headers=headers_value,
        method=method_name,
    )
    return read_json_response(opener, request)

def resolve_runtime_host(api_base, runtime_host):
    value = str(runtime_host or "").strip()
    if value:
        return value
    parsed = urllib.parse.urlsplit(str(api_base or "").strip())
    host = str(parsed.hostname or "127.0.0.1").strip()
    if host in ("", "0.0.0.0", "::", "[::]", "localhost"):
        return "127.0.0.1"
    return host

def build_proxy_url(protocol, host, port, username, password):
    scheme = str(protocol or "http").strip() or "http"
    if username:
        quoted_user = urllib.parse.quote(str(username), safe="")
        quoted_password = urllib.parse.quote(str(password or ""), safe="")
        return f"{scheme}://{quoted_user}:{quoted_password}@{host}:{port}"
    return f"{scheme}://{host}:{port}"

def checkout_random_node_proxy(cfg):
    effective_base = str(cfg.get("easyProxyBaseUrl") or "").strip()
    if not effective_base:
        raise RuntimeError("easyProxyBaseUrl missing")
    api_key = str(cfg.get("easyProxyApiKey") or "").strip()
    settings = api_request("GET", effective_base, api_key, "/api/settings")
    nodes_payload = api_request("GET", effective_base, api_key, "/api/nodes?only_available=1&prefer_available=1")
    nodes = nodes_payload.get("nodes") or []
    if not isinstance(nodes, list) or not nodes:
        raise RuntimeError("EasyProxy random node checkout found no available nodes")

    excluded = {
        str(item).strip().lower()
        for item in (cfg.get("excludedProxyUrls") or [])
        if str(item).strip()
    }
    rng = secrets.SystemRandom()
    candidates = list(nodes)
    rng.shuffle(candidates)

    protocol = str(settings.get("multi_port_protocol") or settings.get("listener_protocol") or "http").strip() or "http"
    username = str(settings.get("multi_port_username") or settings.get("listener_username") or "").strip()
    password = str(settings.get("multi_port_password") or settings.get("listener_password") or "").strip()
    host = resolve_runtime_host(effective_base, cfg.get("easyProxyRuntimeHost"))

    for node in candidates:
        if not isinstance(node, dict):
            continue
        try:
          port = int(node.get("port") or 0)
        except Exception:
          port = 0
        if port <= 0:
            continue
        proxy_url = build_proxy_url(protocol, host, port, username, password)
        if proxy_url.lower() in excluded:
            continue
        return {
            "proxyUrl": proxy_url,
            "metadata": {
                "selectedNodeTag": str(node.get("tag") or "").strip(),
                "selectedNodeName": str(node.get("name") or "").strip(),
                "selectedNodePort": str(port),
                "selectedNodeMode": "dedicated-node",
                "selectedNodeAvailability": str(bool(node.get("available"))).lower(),
                "selectedNodeAvailabilityScore": str(node.get("availability_score") or ""),
                "selectedNodeRegion": str(node.get("region") or "").strip(),
                "selectedNodeCountry": str(node.get("country") or "").strip(),
                "selectedNodeProtocolFamily": str(node.get("protocol_family") or "").strip(),
                "selectedNodeDomainFamily": str(node.get("domain_family") or "").strip(),
                "selectedNodeSourceRef": str(node.get("source_ref") or "").strip(),
            },
        }

    raise RuntimeError("EasyProxy random node checkout exhausted available nodes")

def main():
    proxy_url = str(proxy_cfg.get("upstreamProxyUrl") or "").strip()
    proxy_metadata = {}
    if not proxy_url:
        selected = checkout_random_node_proxy(proxy_cfg)
        proxy_url = str(selected.get("proxyUrl") or "").strip()
        proxy_metadata = selected.get("metadata") or {}
    if not proxy_url:
        raise RuntimeError("proxyUrl missing")

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({
        "http": proxy_url,
        "https": proxy_url,
    }))
    request_body = None
    if body is not None:
        request_body = json.dumps(body).encode("utf-8")
    request = urllib.request.Request(
        base_url.rstrip("/") + path,
        data=request_body,
        headers=headers,
        method=method,
    )
    try:
        with opener.open(request, timeout=35) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            try:
                parsed = json.loads(raw) if raw else {}
            except Exception:
                parsed = raw
            print(json.dumps({
                "status": int(getattr(resp, "status", 200) or 200),
                "body": parsed,
                "proxyUrl": proxy_url,
                "proxyMetadata": proxy_metadata,
            }))
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            parsed = json.loads(raw) if raw else {}
        except Exception:
            parsed = raw
        print(json.dumps({
            "status": int(exc.code),
            "body": parsed,
            "proxyUrl": proxy_url,
            "proxyMetadata": proxy_metadata,
        }))
    except Exception as exc:
        print(json.dumps({
            "proxyUrl": proxy_url,
            "proxyMetadata": proxy_metadata,
            "helperError": str(exc),
        }))

main()
`.trim();
let m2uExecFile: ExecFileFunction = childProcess.execFile;
const m2uKnownGoodProxyUrls = new Map<string, string>();

function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
}

function readStringLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}

function normalizeFilter(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

function normalizeLocalPart(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

function parseTimestampMs(value: string | undefined): number | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseBooleanMetadata(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function resolveProbeMailboxSmokeIntervalMs(instance: ProviderInstance): number {
  const fallbackSeconds = parsePositiveInteger(
    process.env.M2U_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS,
    M2U_DEFAULT_PROBE_MAILBOX_SMOKE_INTERVAL_SECONDS,
  );
  const configuredSeconds = parsePositiveInteger(
    readMetadata(instance, "probeMailboxSmokeIntervalSeconds"),
    fallbackSeconds,
  );
  return Math.max(1, configuredSeconds) * 1000;
}

function resolveCachedProbeMailboxSmokeResult(
  instance: ProviderInstance,
  nowMs: number,
): {
  ok: boolean;
  detail: string;
  metadata: Record<string, string>;
} | undefined {
  const probeAtMs = parseTimestampMs(readMetadata(instance, "lastProbeCreateMailboxAt"));
  if (probeAtMs === undefined) {
    return undefined;
  }

  if ((nowMs - probeAtMs) > resolveProbeMailboxSmokeIntervalMs(instance)) {
    return undefined;
  }

  const cachedOk = parseBooleanMetadata(readMetadata(instance, "lastProbeCreateMailboxOk"));
  if (cachedOk === undefined) {
    return undefined;
  }

  const lastRegistrationOutcome = readMetadata(instance, "lastRegistrationOutcome")?.toLowerCase();
  const lastRegistrationOutcomeAtMs = parseTimestampMs(readMetadata(instance, "lastRegistrationOutcomeAt"));
  if (cachedOk && lastRegistrationOutcome === "failure" && lastRegistrationOutcomeAtMs !== undefined && lastRegistrationOutcomeAtMs > probeAtMs) {
    return undefined;
  }

  const detail = readMetadata(instance, "lastProbeCreateMailboxDetail")
    ?? (cachedOk ? "cached_probe_mailbox_smoke_success" : "cached_probe_mailbox_smoke_failure");
  const metadata: Record<string, string> = {
    lastProbeCreateMailboxAt: new Date(probeAtMs).toISOString(),
    lastProbeCreateMailboxOk: cachedOk ? "true" : "false",
    lastProbeCreateMailboxDetail: detail,
  };
  const cachedEmail = readMetadata(instance, "lastProbeCreateMailboxEmail");
  if (cachedEmail) {
    metadata.lastProbeCreateMailboxEmail = cachedEmail;
  }
  return {
    ok: cachedOk,
    detail,
    metadata,
  };
}

function domainMatchesPreference(domain: string | undefined, preferredDomain: string | undefined): boolean {
  const normalizedDomain = normalizeFilter(domain);
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedDomain || !normalizedPreferredDomain) {
    return false;
  }

  return normalizedDomain === normalizedPreferredDomain
    || normalizedDomain.endsWith(`.${normalizedPreferredDomain}`);
}

function resolvePreferredDomains(domains: string[], preferredDomain: string | undefined): string[] {
  const normalizedPreferredDomain = normalizeFilter(preferredDomain);
  if (!normalizedPreferredDomain) {
    return [];
  }

  return [...new Set(domains
    .map((domain) => normalizeFilter(domain))
    .filter((domain): domain is string => Boolean(domain))
    .filter((domain) => domainMatchesPreference(domain, normalizedPreferredDomain)))];
}

function computeDomainMatchAttempts(totalDomainCount: number, matchedDomainCount: number): number {
  if (totalDomainCount <= 0 || matchedDomainCount <= 0 || matchedDomainCount >= totalDomainCount) {
    return 1;
  }

  const failureProbability = 1 - (matchedDomainCount / totalDomainCount);
  if (failureProbability <= 0) {
    return 1;
  }

  const attempts = Math.ceil(
    Math.log(1 - M2U_DOMAIN_MATCH_CONFIDENCE_TARGET) / Math.log(failureProbability),
  );
  return Math.min(M2U_DOMAIN_MATCH_MAX_ATTEMPTS, Math.max(2, attempts));
}

function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const normalizedFilter = normalizeFilter(fromContains);
  if (!normalizedFilter) {
    return true;
  }

  const normalizedSender = readStringLike(sender)?.toLowerCase();
  if (!normalizedSender) {
    return false;
  }

  return normalizedSender.includes(normalizedFilter);
}

function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

function encodeQuery(params: Record<string, string | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function readErrorCode(body: unknown): string | undefined {
  return readStringLike(asRecord(body).error)?.toLowerCase();
}

function readErrorReason(body: unknown): string | undefined {
  return readStringLike(asRecord(body).reason);
}

function hasM2uBodyError(body: unknown): boolean {
  return Boolean(readErrorCode(body));
}

function classifyM2uError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

function classifyM2uResponse(status: number, body: unknown, phase: string): "transient" | "capacity" | "provider" {
  if (hasM2uBodyError(body)) {
    return classifyM2uError(formatM2uError(phase, status, body).message);
  }
  return classifyM2uError(`status ${status}`);
}

function formatM2uError(phase: string, status: number, body: unknown): Error {
  const errorCode = readErrorCode(body);
  const reason = readErrorReason(body);
  const detailParts = [
    errorCode ? `error=${errorCode}` : undefined,
    reason ? `reason=${reason}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const rawMessage = `M2U ${phase} failed with status ${status}${detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""}.`;
  const category = classifyM2uError(rawMessage);
  if (category === "capacity") {
    return new Error(`M2U_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`M2U_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`M2U_PROVIDER_FAILURE: ${rawMessage}`);
}

function buildRequestHeaders(config: M2uConfig, options: RequestJsonOptions): Record<string, string> {
  return {
    Accept: "application/json",
    "User-Agent": config.userAgent,
    "Accept-Language": config.acceptLanguage,
    "Accept-Encoding": config.acceptEncoding,
    ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
  };
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
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers: buildRequestHeaders(config, options),
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

async function requestJson(
  config: M2uConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  try {
    const direct = await requestJsonDirect(config, method, path, options);
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

export function resolveM2uConfig(instance: ProviderInstance): M2uConfig {
  const env = process.env;
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
    userAgent: readMetadata(instance, "userAgent") ?? M2U_DEFAULT_USER_AGENT,
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

export function setM2uExecFileForTesting(execFileImpl: ExecFileFunction | undefined): void {
  m2uExecFile = execFileImpl ?? childProcess.execFile;
}

export function encodeM2uMailboxRef(instanceId: string, mailbox: M2uMailboxCredentials): string {
  return `m2u:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeM2uMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): M2uMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `m2u:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    const viewToken = readStringLike(payload.viewToken) ?? readStringLike(payload.view_token) ?? "";
    if (!email || !token || !viewToken || !email.includes("@")) {
      return undefined;
    }

    return {
      email: email.trim().toLowerCase(),
      token: token.trim(),
      viewToken: viewToken.trim(),
      mailboxId: readStringLike(payload.mailboxId ?? payload.mailbox_id ?? payload.id),
      expiresAt: readStringLike(payload.expiresAt ?? payload.expires_at),
    };
  } catch {
    return undefined;
  }
}

export class M2uClient {
  public constructor(private readonly config: M2uConfig) {}

  public static fromInstance(instance: ProviderInstance): M2uClient {
    return new M2uClient(resolveM2uConfig(instance));
  }

  public async getDomains(): Promise<string[]> {
    const response = await requestJson(this.config, "GET", "/v1/domains");
    if (response.status !== 200 || hasM2uBodyError(response.body)) {
      throw formatM2uError("getDomains", response.status, response.body);
    }

    const domains = Array.isArray(asRecord(response.body).domains)
      ? asRecord(response.body).domains as unknown[]
      : [];
    return domains
      .map((item) => readStringLike(item))
      .filter((item): item is string => Boolean(item));
  }

  public async createMailbox(options: {
    token?: string;
    preferredDomain?: string;
    requestedLocalPart?: string;
    turnstileToken?: string;
  } = {}): Promise<M2uMailboxCredentials> {
    const preferredDomain = normalizeFilter(options.preferredDomain ?? this.config.preferredDomain);
    const requestedLocalPart = normalizeLocalPart(options.requestedLocalPart);
    const turnstileToken = normalizeLocalPart(options.turnstileToken);

    // The production registration flow only needs "a usable mailbox". If the
    // caller provides a preferred local-part but cannot supply a Turnstile
    // token, degrade to the auto mailbox flow instead of failing hard.
    if (requestedLocalPart && preferredDomain && turnstileToken) {
      return await this.createCustomMailbox({
        localPart: requestedLocalPart,
        domain: preferredDomain,
        turnstileToken,
      });
    }

    let preferredDomains: string[] = [];
    let attempts = 1;

    if (preferredDomain) {
      const domains = await this.getDomains();
      preferredDomains = resolvePreferredDomains(domains, preferredDomain);
      if (preferredDomains.length === 0) {
        throw new Error(`M2U_PROVIDER_FAILURE: M2U has no available domains matching "${preferredDomain}".`);
      }
      attempts = computeDomainMatchAttempts(domains.length, preferredDomains.length);
    }

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const requestedDomain = preferredDomains.length > 0
        ? preferredDomains[attempt % preferredDomains.length]
        : undefined;
      const payload = {
        ...(options.token?.trim() ? { token: options.token.trim() } : {}),
        ...(requestedDomain ? { domain: requestedDomain } : {}),
      };
      const response = await requestJson(this.config, "POST", "/v1/mailboxes/auto", {
        jsonBody: payload,
      });

      if ((response.status !== 200 && response.status !== 201) || hasM2uBodyError(response.body)) {
        throw formatM2uError("createMailbox", response.status, response.body);
      }

      const mailbox = asRecord(asRecord(response.body).mailbox);
      const localPart = readStringLike(mailbox.local_part);
      const domain = normalizeFilter(readStringLike(mailbox.domain));
      const token = readStringLike(mailbox.token);
      const viewToken = readStringLike(mailbox.view_token);
      if (!localPart || !domain || !token || !viewToken) {
        throw new Error("M2U_PROVIDER_FAILURE: M2U createMailbox returned an incomplete mailbox payload.");
      }

      if (preferredDomain && !domainMatchesPreference(domain, preferredDomain)) {
        continue;
      }

      return {
        email: `${localPart}@${domain}`.toLowerCase(),
        token,
        viewToken,
        mailboxId: readStringLike(mailbox.id),
        expiresAt: readStringLike(mailbox.expires_at),
      };
    }

    throw new Error(`M2U_PROVIDER_FAILURE: M2U could not obtain a mailbox matching "${preferredDomain}" after ${attempts} attempts.`);
  }

  private async createCustomMailbox(input: {
    localPart: string;
    domain: string;
    turnstileToken: string;
  }): Promise<M2uMailboxCredentials> {
    const response = await requestJson(this.config, "POST", "/v1/mailboxes/custom", {
      jsonBody: {
        localPart: input.localPart,
        domain: input.domain,
        turnstileToken: input.turnstileToken,
      },
    });

    if ((response.status !== 200 && response.status !== 201) || hasM2uBodyError(response.body)) {
      throw formatM2uError("createCustomMailbox", response.status, response.body);
    }

    const mailbox = asRecord(asRecord(response.body).mailbox);
    const localPart = readStringLike(mailbox.local_part);
    const domain = normalizeFilter(readStringLike(mailbox.domain));
    const token = readStringLike(mailbox.token);
    const viewToken = readStringLike(mailbox.view_token);
    if (!localPart || !domain || !token || !viewToken) {
      throw new Error("M2U_PROVIDER_FAILURE: M2U createCustomMailbox returned an incomplete mailbox payload.");
    }

    if (localPart !== input.localPart || !domainMatchesPreference(domain, input.domain)) {
      throw new Error(
        `M2U_PROVIDER_FAILURE: M2U custom mailbox returned mismatched address requested=${input.localPart}@${input.domain} actual=${localPart}@${domain}.`,
      );
    }

    return {
      email: `${localPart}@${domain}`.toLowerCase(),
      token,
      viewToken,
      mailboxId: readStringLike(mailbox.id),
      expiresAt: readStringLike(mailbox.expires_at),
    };
  }

  public async listMessages(token: string, viewToken: string): Promise<Record<string, unknown>[]> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}${"/messages"}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500 || hasM2uBodyError(response.body)) {
      throw formatM2uError("listMessages", response.status, response.body);
    }
    if (response.status !== 200) {
      return [];
    }

    return asRecordList(asRecord(response.body).messages);
  }

  public async getMessage(token: string, viewToken: string, messageId: string): Promise<Record<string, unknown>> {
    const response = await requestJson(
      this.config,
      "GET",
      `/v1/mailboxes/${encodeURIComponent(token)}/messages/${encodeURIComponent(messageId)}${encodeQuery({ view: viewToken })}`,
    );
    if (response.status === 429 || response.status >= 500 || hasM2uBodyError(response.body)) {
      throw formatM2uError("getMessage", response.status, response.body);
    }
    if (response.status !== 200) {
      return {};
    }

    return asRecord(asRecord(response.body).message);
  }

  public async tryReadLatestCode(
    sessionId: string,
    mailbox: M2uMailboxCredentials,
    providerInstanceId: string,
    fromContains?: string,
  ): Promise<ObservedMessage | undefined> {
    const messages = await this.listMessages(mailbox.token, mailbox.viewToken);

    for (const item of messages) {
      const messageId = readStringLike(item.id) ?? sessionId;
      const sender = readStringLike(item.from_addr ?? item.from);
      if (!matchesSenderFilter(sender, fromContains)) {
        continue;
      }

      const subject = readStringLike(item.subject);
      const summaryOtp = extractOtp({ subject });
      if (summaryOtp) {
        return {
          id: `m2u:${messageId}`,
          sessionId,
          providerInstanceId,
          observedAt: readStringLike(item.received_at) ?? "",
          sender,
          subject,
          extractedCode: summaryOtp.code,
          extractedCandidates: summaryOtp.candidates,
          codeSource: summaryOtp.source,
        };
      }

      const detail = await this.getMessage(mailbox.token, mailbox.viewToken, messageId);
      const detailSender = readStringLike(detail.from_addr ?? detail.from) ?? sender;
      if (!matchesSenderFilter(detailSender, fromContains)) {
        continue;
      }

      const detailSubject = readStringLike(detail.subject) ?? subject;
      const textBody = readStringLike(detail.text_body ?? detail.textBody ?? detail.text);
      const htmlBody = readStringLike(detail.html_body ?? detail.htmlBody ?? detail.html);
      const detailOtp = extractOtp({
        subject: detailSubject,
        textBody,
        htmlBody,
      });

      return {
        id: `m2u:${messageId}`,
        sessionId,
        providerInstanceId,
        observedAt: readStringLike(detail.received_at) ?? readStringLike(item.received_at) ?? "",
        sender: detailSender,
        subject: detailSubject,
        textBody,
        htmlBody,
        extractedCode: detailOtp?.code,
        extractedCandidates: detailOtp?.candidates,
        codeSource: detailOtp?.source,
      };
    }

    return undefined;
  }
}

export async function probeM2uInstance(instance: ProviderInstance): Promise<{
  ok: boolean;
  detail: string;
  averageLatencyMs: number;
  metadata?: Record<string, string>;
}> {
  const client = M2uClient.fromInstance(instance);
  const startedAt = Date.now();
  try {
    const domains = await client.getDomains();
    const nowMs = Date.now();
    const cachedSmoke = resolveCachedProbeMailboxSmokeResult(instance, nowMs);
    if (cachedSmoke) {
      return {
        ok: cachedSmoke.ok && domains.length > 0,
        detail: cachedSmoke.detail,
        averageLatencyMs: nowMs - startedAt,
        metadata: {
          provider: "m2u",
          state: cachedSmoke.ok && domains.length > 0 ? "ok" : "probe_mailbox_smoke_failed",
          ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
          ...cachedSmoke.metadata,
        },
      };
    }

    const mailbox = await client.createMailbox();
    const smokeDetail = `M2U createMailbox smoke check succeeded: ${mailbox.email}`;
    return {
      ok: domains.length > 0,
      detail: domains.length > 0
        ? smokeDetail
        : "M2U returned no available domains.",
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        state: domains.length > 0 ? "ok" : "empty-domain-list",
        ...(domains.length > 0 ? { domainsCsv: domains.join(",") } : {}),
        lastProbeCreateMailboxAt: new Date().toISOString(),
        lastProbeCreateMailboxOk: "true",
        lastProbeCreateMailboxEmail: mailbox.email,
        lastProbeCreateMailboxDetail: smokeDetail,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const classification = classifyM2uError(detail);
    return {
      ok: false,
      detail,
      averageLatencyMs: Date.now() - startedAt,
      metadata: {
        provider: "m2u",
        errorClass: classification,
        lastProbeCreateMailboxAt: new Date().toISOString(),
        lastProbeCreateMailboxOk: "false",
        lastProbeCreateMailboxDetail: detail,
      },
    };
  }
}
