import { HttpError } from "./http";

export const DEFAULT_WORKBUDDY_BASE_URL = "https://www.workbuddy.cn";
const LOGIN_TOKEN_PENDING_CODE = 11217;
const LOGIN_ACCOUNT_PENDING_CODE = 12151;
export const MAX_WB_JSON_BYTES = 2 * 1024 * 1024;

const ALLOWED_API_DOMAINS = new Set([
  "www.workbuddy.cn",
  "copilot.tencent.com",
  "www.codebuddy.cn",
  "wb.tencentbuddy.com",
]);

export interface WorkBuddyTokenCredentials {
  accessToken: string;
  refreshToken: string;
  uid: string;
  enterpriseId?: string;
  tenantId?: string;
  domain: string;
  baseUrl: string;
  expiresAt?: number;
}

export interface WorkBuddyDailyQuota {
  limit: number;
  remaining: number;
  reset: number;
  hasQuota: boolean;
}

export interface WorkBuddyAlias {
  aliasId: string;
  email: string;
  isPrimary: boolean;
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

export function resolveWorkBuddyBaseUrl(
  raw: string | undefined,
  allowLoopback = false,
): { baseUrl: string; domain: string } {
  let trimmed = (raw ?? "").trim();
  if (!trimmed) trimmed = DEFAULT_WORKBUDDY_BASE_URL;
  else if (!trimmed.includes("://")) trimmed = `https://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new HttpError(400, "invalid_workbuddy_domain");
  }
  if (parsed.username || parsed.password) throw new HttpError(400, "invalid_workbuddy_domain");
  const host = parsed.hostname.toLowerCase();
  if (allowLoopback && isLoopbackHost(host) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return { baseUrl: `${parsed.protocol}//${parsed.host}`, domain: parsed.host };
  }
  if (parsed.protocol !== "https:" || !ALLOWED_API_DOMAINS.has(host)) {
    throw new HttpError(400, "invalid_workbuddy_domain");
  }
  return { baseUrl: `https://${parsed.host}`, domain: parsed.host };
}

export function validateWorkBuddyAuthBrowserUrl(rawUrl: string, allowLoopback = false): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new HttpError(502, "workbuddy_gateway_failed");
  }
  if (parsed.username || parsed.password) throw new HttpError(502, "workbuddy_gateway_failed");
  const host = parsed.hostname.toLowerCase();
  if (allowLoopback && isLoopbackHost(host) && (parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return parsed.toString();
  }
  const trusted = ["workbuddy.cn", "codebuddy.cn", "tencentbuddy.com", "tencent.com", "qq.com"].some(
    (sfx) => host === sfx || host.endsWith(`.${sfx}`),
  );
  if (parsed.protocol !== "https:" || !trusted) {
    throw new HttpError(502, "workbuddy_gateway_failed");
  }
  return parsed.toString();
}

function parseQuotaHeaders(headers: Headers): WorkBuddyDailyQuota {
  const readInt = (name: string): [number, boolean] => {
    const raw = headers.get(name)?.trim() ?? "";
    if (!raw || !/^-?\d+$/.test(raw)) return [0, false];
    return [Number.parseInt(raw, 10), true];
  };
  const [limit, okL] = readInt("x-dailyquota-limit");
  const [remaining, okR] = readInt("x-dailyquota-remaining");
  const [reset, okS] = readInt("x-dailyquota-reset");
  return { limit, remaining, reset, hasQuota: okL || okR || okS };
}

export function unwrapWorkBuddyEnvelope(body: unknown): { code: number; msg: string; data: unknown } {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const env = body as { code?: unknown; msg?: unknown; data?: unknown };
    if (typeof env.code === "number" || typeof env.msg === "string" || env.data !== undefined) {
      return {
        code: typeof env.code === "number" ? env.code : 0,
        msg: typeof env.msg === "string" ? env.msg : "",
        data: env.data !== undefined && env.data !== null ? env.data : body,
      };
    }
  }
  return { code: 0, msg: "", data: body };
}

export async function fetchWorkBuddyBoundedJson(
  url: string,
  init: RequestInit,
  maxBytes = MAX_WB_JSON_BYTES,
  timeoutMs = 15000,
): Promise<{ status: number; body: unknown; quota: WorkBuddyDailyQuota }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
    const quota = parseQuotaHeaders(resp.headers);
    const text = await resp.text();
    if (text.length > maxBytes) throw new HttpError(413, "workbuddy_response_too_large");
    let parsed: unknown = {};
    if (text.trim()) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = {};
      }
    }
    return { status: resp.status, body: parsed, quota };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new HttpError(504, "workbuddy_timeout");
    }
    throw new HttpError(502, "workbuddy_gateway_failed");
  } finally {
    clearTimeout(timer);
  }
}

export async function startWorkBuddyBrowserAuth(
  baseUrlInput?: string,
  allowLoopback = false,
): Promise<{ state: string; authUrl: string; baseUrl: string; domain: string }> {
  const { baseUrl, domain } = resolveWorkBuddyBaseUrl(baseUrlInput, allowLoopback);
  const { status, body } = await fetchWorkBuddyBoundedJson(
    `${baseUrl}/v2/plugin/auth/state?platform=workbuddy`,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "x-product": "SaaS",
        "x-domain": domain,
      },
      body: "{}",
    },
  );
  const env = unwrapWorkBuddyEnvelope(body);
  const data = (env.data ?? {}) as { state?: string; authUrl?: string };
  if (status >= 400 || env.code !== 0 || !data.state?.trim() || !data.authUrl?.trim()) {
    throw new HttpError(502, "workbuddy_gateway_failed");
  }
  return {
    state: data.state.trim(),
    authUrl: validateWorkBuddyAuthBrowserUrl(data.authUrl, allowLoopback),
    baseUrl,
    domain,
  };
}

export async function pollWorkBuddyAuthTokenOnce(
  baseUrl: string,
  domain: string,
  state: string,
  allowLoopback = false,
): Promise<{ pending: true } | { pending: false; credentials: WorkBuddyTokenCredentials }> {
  const { status, body } = await fetchWorkBuddyBoundedJson(
    `${baseUrl}/v2/plugin/auth/token?state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: { accept: "application/json", "x-product": "SaaS", "x-domain": domain },
    },
  );
  if (status === 202) return { pending: true };
  const env = unwrapWorkBuddyEnvelope(body);
  if (env.code === LOGIN_TOKEN_PENDING_CODE) return { pending: true };
  if (status >= 400) throw new HttpError(401, "workbuddy_auth_required");
  const raw = (env.data ?? {}) as {
    status?: string;
    accessToken?: string;
    refreshToken?: string;
    domain?: string;
    expiresAt?: number;
    expiresIn?: number;
  };
  if (!raw.accessToken?.trim()) {
    if (!raw.status || raw.status.toLowerCase() === "pending") return { pending: true };
    throw new HttpError(401, "workbuddy_auth_required");
  }
  let resolved = { baseUrl, domain };
  if (raw.domain?.trim()) {
    try {
      resolved = resolveWorkBuddyBaseUrl(raw.domain, allowLoopback);
    } catch {
      // Keep original resolved base URL.
    }
  }
  const account = await fetchWorkBuddyAccountInfo(
    {
      accessToken: raw.accessToken.trim(),
      refreshToken: (raw.refreshToken ?? "").trim(),
      uid: "",
      baseUrl: resolved.baseUrl,
      domain: resolved.domain,
      expiresAt: raw.expiresAt || (raw.expiresIn ? Date.now() + raw.expiresIn * 1000 : undefined),
    },
    allowLoopback,
  );
  return { pending: false, credentials: account };
}

async function fetchWorkBuddyAccountInfo(
  creds: WorkBuddyTokenCredentials,
  allowLoopback: boolean,
): Promise<WorkBuddyTokenCredentials> {
  const { baseUrl, domain } = resolveWorkBuddyBaseUrl(creds.baseUrl || creds.domain, allowLoopback);
  const { status, body } = await fetchWorkBuddyBoundedJson(`${baseUrl}/v2/plugin/account`, {
    method: "GET",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${creds.accessToken}`,
      "x-domain": domain,
      "x-product": "SaaS",
    },
  });
  const env = unwrapWorkBuddyEnvelope(body);
  if (env.code === LOGIN_ACCOUNT_PENDING_CODE) throw new HttpError(409, "workbuddy_auth_pending");
  if (status === 401 || status === 403) throw new HttpError(401, "workbuddy_auth_required");
  if (status >= 400 || env.code !== 0) throw new HttpError(502, "workbuddy_gateway_failed");
  const raw = (env.data ?? {}) as {
    uid?: string;
    id?: string;
    userId?: string;
    enterpriseId?: string;
    tenantId?: string;
  };
  const uid = (raw.uid || raw.id || raw.userId || "").trim();
  if (!uid) throw new HttpError(502, "workbuddy_gateway_failed");
  return {
    ...creds,
    uid,
    enterpriseId: raw.enterpriseId?.trim() || undefined,
    tenantId: (raw.tenantId || raw.enterpriseId || "").trim() || undefined,
    baseUrl,
    domain,
  };
}

export async function refreshWorkBuddyToken(
  creds: WorkBuddyTokenCredentials,
  allowLoopback = false,
): Promise<WorkBuddyTokenCredentials> {
  if (!creds.refreshToken.trim()) throw new HttpError(401, "workbuddy_auth_required");
  const { baseUrl, domain } = resolveWorkBuddyBaseUrl(creds.baseUrl || creds.domain, allowLoopback);
  const { status, body } = await fetchWorkBuddyBoundedJson(`${baseUrl}/v2/plugin/auth/token/refresh`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-refresh-token": creds.refreshToken,
      "x-auth-refresh-source": "plugin",
      "x-domain": domain,
      "x-product": "SaaS",
    },
    body: "{}",
  });
  const env = unwrapWorkBuddyEnvelope(body);
  const raw = (env.data ?? {}) as { accessToken?: string; refreshToken?: string };
  if (status >= 400 || env.code !== 0 || !raw.accessToken?.trim()) {
    throw new HttpError(401, "workbuddy_auth_required");
  }
  return {
    ...creds,
    accessToken: raw.accessToken.trim(),
    refreshToken: raw.refreshToken?.trim() || creds.refreshToken,
  };
}

export async function requestWorkBuddyGateway(input: {
  creds: WorkBuddyTokenCredentials;
  method: string;
  relPath: string;
  query?: Record<string, string>;
  jsonBody?: unknown;
  maxBytes?: number;
  allowLoopback?: boolean;
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>;
}): Promise<{ status: number; body: unknown; quota: WorkBuddyDailyQuota }> {
  const execOnce = async (creds: WorkBuddyTokenCredentials) => {
    const { baseUrl, domain } = resolveWorkBuddyBaseUrl(creds.baseUrl || creds.domain, input.allowLoopback);
    const qs = input.query ? new URLSearchParams(input.query).toString() : "";
    const url = `${baseUrl}${input.relPath}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${creds.accessToken}`,
      "x-domain": domain,
    };
    if (creds.uid) headers["x-user-id"] = encodeURIComponent(creds.uid);
    if (creds.enterpriseId) headers["x-enterprise-id"] = creds.enterpriseId;
    if (creds.tenantId) headers["x-tenant-id"] = creds.tenantId;
    if (input.jsonBody !== undefined) headers["content-type"] = "application/json";
    return fetchWorkBuddyBoundedJson(
      url,
      {
        method: input.method,
        headers,
        body: input.jsonBody !== undefined ? JSON.stringify(input.jsonBody) : undefined,
      },
      input.maxBytes ?? MAX_WB_JSON_BYTES,
    );
  };

  const first = await execOnce(input.creds);
  const errCode = ((first.body as { error?: { code?: string } })?.error?.code ?? "").trim();
  if (first.status !== 401 && errCode !== "AUTHENTICATION_REQUIRED") {
    return first;
  }
  const refreshed = await refreshWorkBuddyToken(input.creds, input.allowLoopback);
  if (input.onRefreshed) await input.onRefreshed(refreshed);
  return execOnce(refreshed);
}

export function mapWorkBuddyRestError(status: number, body: unknown): void {
  const errObj = (body as { error?: { code?: string } })?.error;
  if (errObj?.code === "AUTHENTICATION_REQUIRED" || status === 401 || status === 403) {
    throw new HttpError(401, "workbuddy_auth_required");
  }
  if (errObj?.code === "DAILY_QUOTA_EXCEEDED") throw new HttpError(429, "workbuddy_quota_exceeded");
  if (errObj?.code === "RATE_LIMIT_EXCEEDED" || status === 429) throw new HttpError(429, "workbuddy_rate_limited");
  if (errObj?.code === "NOT_FOUND" || status === 404) throw new HttpError(404, "not_found");
  if (status >= 400) throw new HttpError(502, "workbuddy_gateway_failed");
}
