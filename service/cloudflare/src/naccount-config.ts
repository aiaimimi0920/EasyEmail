import type { Env } from "./contracts";
import { HttpError } from "./http";

export interface NaccountRuntimeConfig {
  issuer: string;
  clientId: string;
  redirectUri: string;
  accountUrl: string;
  logoutUrl: string;
  postLogoutRedirectUri: string;
  bootstrapAdminUsername: string;
}

export type PublicAuthConfig =
  | { mode: "local" }
  | {
      mode: "naccount";
      issuer: string;
      clientId: string;
      redirectUri: string;
      accountUrl: string;
      logoutUrl: string;
      postLogoutRedirectUri: string;
    };

const PRODUCTION_ORIGINS: Readonly<Record<string, { issuer: string; clientId: string; bootstrapAdminUsername: string }>> = {
  "https://mail.aiaimimi.com": {
    issuer: "https://naccount-auth.aiaimimi.com",
    clientId: "easyemail-web",
    bootstrapAdminUsername: "admin",
  },
};

const isLoopback = (hostname: string) => ["localhost", "127.0.0.1", "[::1]"].includes(hostname);

function validOriginUrl(raw: string, allowLoopbackHttp: boolean): URL {
  const parsed = new URL(raw);
  const httpsOk = parsed.protocol === "https:";
  const loopbackHttpOk = allowLoopbackHttp && parsed.protocol === "http:" && isLoopback(parsed.hostname);
  if ((!httpsOk && !loopbackHttpOk) || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/") {
    throw new Error("Invalid origin URL");
  }
  return parsed;
}

export function resolveNaccountConfig(env: Env): NaccountRuntimeConfig | null {
  let appUrl: URL;
  try {
    appUrl = new URL(env.APP_ORIGIN);
    if (appUrl.origin !== env.APP_ORIGIN) throw new Error("Invalid APP_ORIGIN");
  } catch {
    throw new HttpError(503, "naccount_config_invalid");
  }
  const loopbackApp = appUrl.protocol === "http:" && isLoopback(appUrl.hostname);
  const builtin = PRODUCTION_ORIGINS[appUrl.origin];
  if (env.NACCOUNT_CONFIG === undefined) {
    if (!builtin) return null;
    return buildRuntimeConfig(appUrl.origin, builtin.issuer, builtin.clientId, builtin.bootstrapAdminUsername);
  }
  try {
    const parsed: unknown = JSON.parse(env.NACCOUNT_CONFIG);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid NACCOUNT_CONFIG");
    const record = parsed as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["enabled", "issuer", "clientId", "bootstrapAdminUsername"].includes(key))) {
      throw new Error("Unexpected NACCOUNT_CONFIG field");
    }
    if (record.enabled === false) return null;
    const issuerRaw = typeof record.issuer === "string" ? record.issuer : builtin?.issuer;
    const clientId = typeof record.clientId === "string" ? record.clientId : builtin?.clientId;
    const adminUsername = typeof record.bootstrapAdminUsername === "string"
      ? record.bootstrapAdminUsername.toLowerCase()
      : (builtin?.bootstrapAdminUsername ?? "admin");
    if (!issuerRaw || !clientId || !/^[A-Za-z0-9._-]{3,128}$/.test(clientId) || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(adminUsername)) {
      throw new Error("Invalid NACCOUNT_CONFIG values");
    }
    const issuerUrl = validOriginUrl(issuerRaw.endsWith("/") ? issuerRaw : `${issuerRaw}/`, loopbackApp);
    return buildRuntimeConfig(appUrl.origin, issuerUrl.origin, clientId, adminUsername);
  } catch {
    throw new HttpError(503, "naccount_config_invalid");
  }
}

function buildRuntimeConfig(appOrigin: string, issuer: string, clientId: string, bootstrapAdminUsername: string): NaccountRuntimeConfig {
  return {
    issuer,
    clientId,
    redirectUri: new URL("/auth/callback", appOrigin).href,
    accountUrl: `${issuer}/account`,
    logoutUrl: `${issuer}/oauth2/v1/logout`,
    postLogoutRedirectUri: appOrigin,
    bootstrapAdminUsername,
  };
}

export function publicAuthConfig(env: Env): PublicAuthConfig {
  const resolved = resolveNaccountConfig(env);
  if (!resolved) return { mode: "local" };
  return {
    mode: "naccount",
    issuer: resolved.issuer,
    clientId: resolved.clientId,
    redirectUri: resolved.redirectUri,
    accountUrl: resolved.accountUrl,
    logoutUrl: resolved.logoutUrl,
    postLogoutRedirectUri: resolved.postLogoutRedirectUri,
  };
}
