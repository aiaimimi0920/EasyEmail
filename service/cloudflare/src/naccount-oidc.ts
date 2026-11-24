import { unixNow } from "./contracts";
import { HttpError } from "./http";
import type { NaccountRuntimeConfig } from "./naccount-config";

export interface VerifiedNaccountProfile {
  sub: string;
  email: string | null;
  emailVerified: boolean;
  nickname: string | null;
  preferredUsername: string | null;
  roles: string[];
}

interface JwkRecord {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

let jwksCache: { issuer: string; expiresAt: number; fetchRef: typeof fetch; keys: JwkRecord[] } | null = null;

export const validAuthCode = (value: unknown): value is string =>
  typeof value === "string" && /^[\x21-\x7e]{16,2048}$/.test(value);

export const validCodeVerifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);

function decodeBase64Url(input: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(input)) throw new Error("Invalid base64url");
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeJwtObject(segment: string): Record<string, unknown> {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(decodeBase64Url(segment)));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid JWT segment");
  return value as Record<string, unknown>;
}

async function fetchJson(url: string, init: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null }> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, "naccount_provider_unavailable");
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new HttpError(502, "naccount_provider_unavailable");
  }
  try {
    const parsed: unknown = await response.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { status: response.status, body: null };
    return { status: response.status, body: parsed as Record<string, unknown> };
  } catch {
    return { status: response.status, body: null };
  }
}

async function loadSigningKey(issuer: string, kid: string): Promise<CryptoKey> {
  const now = Date.now();
  let keys = jwksCache && jwksCache.issuer === issuer && jwksCache.fetchRef === fetch && jwksCache.expiresAt > now
    ? jwksCache.keys
    : null;
  let selected = keys?.find((entry) => entry.kid === kid);
  if (!selected) {
    const { status, body } = await fetchJson(`${issuer}/.well-known/jwks.json`, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (status !== 200 || !body || !Array.isArray(body.keys)) throw new HttpError(502, "naccount_provider_unavailable");
    keys = body.keys.filter((item): item is JwkRecord => Boolean(item && typeof item === "object" && !Array.isArray(item)));
    jwksCache = { issuer, expiresAt: now + 300_000, fetchRef: fetch, keys };
    selected = keys.find((entry) => entry.kid === kid);
  }
  if (!selected || selected.kty !== "RSA" || typeof selected.n !== "string" || typeof selected.e !== "string"
    || (selected.alg !== undefined && selected.alg !== "RS256")
    || (selected.use !== undefined && selected.use !== "sig")) {
    throw new HttpError(401, "naccount_token_invalid");
  }
  try {
    return await crypto.subtle.importKey(
      "jwk",
      { kty: "RSA", n: selected.n, e: selected.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new HttpError(401, "naccount_token_invalid");
  }
}

async function verifyIdToken(config: NaccountRuntimeConfig, idToken: string): Promise<string> {
  const segments = idToken.split(".");
  if (segments.length !== 3 || segments.some((part) => !part)) throw new HttpError(401, "naccount_token_invalid");
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  let signature: Uint8Array;
  try {
    header = decodeJwtObject(segments[0]);
    payload = decodeJwtObject(segments[1]);
    signature = decodeBase64Url(segments[2]);
  } catch {
    throw new HttpError(401, "naccount_token_invalid");
  }
  if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid || header.kid.length > 128) {
    throw new HttpError(401, "naccount_token_invalid");
  }
  const now = unixNow();
  const aud = payload.aud;
  const audMatches = aud === config.clientId || (Array.isArray(aud) && aud.includes(config.clientId));
  if (payload.iss !== config.issuer || !audMatches
    || (payload.azp !== undefined && payload.azp !== config.clientId)
    || typeof payload.sub !== "string" || payload.sub.length < 3 || payload.sub.length > 128
    || typeof payload.exp !== "number" || payload.exp <= now - 30
    || typeof payload.iat !== "number" || payload.iat > now + 60) {
    throw new HttpError(401, "naccount_token_invalid");
  }
  const key = await loadSigningKey(config.issuer, header.kid);
  const signedBytes = new TextEncoder().encode(`${segments[0]}.${segments[1]}`);
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, signedBytes);
  if (!valid) throw new HttpError(401, "naccount_token_invalid");
  return payload.sub;
}

export async function exchangeNaccountCode(
  config: NaccountRuntimeConfig,
  code: string,
  codeVerifier: string,
): Promise<VerifiedNaccountProfile> {
  const tokenRes = await fetchJson(`${config.issuer}/oauth2/v1/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: codeVerifier,
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
    }).toString(),
  });
  if ([400, 401, 403].includes(tokenRes.status)) throw new HttpError(401, "naccount_code_rejected");
  if (tokenRes.status !== 200 || !tokenRes.body) throw new HttpError(502, "naccount_provider_unavailable");
  const accessToken = tokenRes.body.access_token;
  const idToken = tokenRes.body.id_token;
  const tokenType = typeof tokenRes.body.token_type === "string" ? tokenRes.body.token_type.toLowerCase() : "";
  if (tokenType !== "bearer" || typeof accessToken !== "string" || !accessToken || typeof idToken !== "string" || !idToken) {
    throw new HttpError(502, "naccount_token_invalid");
  }
  const verifiedSub = await verifyIdToken(config, idToken);
  const infoRes = await fetchJson(`${config.issuer}/oauth2/v1/userinfo`, {
    method: "GET",
    headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
  });
  if ([401, 403, 404].includes(infoRes.status)) throw new HttpError(403, "naccount_user_unavailable");
  if (infoRes.status !== 200 || !infoRes.body) throw new HttpError(502, "naccount_provider_unavailable");
  const sub = typeof infoRes.body.sub === "string" ? infoRes.body.sub : infoRes.body.authId;
  if (typeof sub !== "string" || sub !== verifiedSub) throw new HttpError(401, "naccount_token_invalid");
  const email = typeof infoRes.body.email === "string" && infoRes.body.email.trim() ? infoRes.body.email.trim().toLowerCase() : null;
  const nickname = typeof infoRes.body.nickname === "string" && infoRes.body.nickname.trim() ? infoRes.body.nickname.trim() : null;
  const preferredUsername = typeof infoRes.body.preferred_username === "string" && infoRes.body.preferred_username.trim()
    ? infoRes.body.preferred_username.trim()
    : null;
  const roles = Array.isArray(infoRes.body.roles)
    ? infoRes.body.roles.filter((role): role is string => typeof role === "string" && role.length <= 64)
    : [];
  return { sub, email, emailVerified: infoRes.body.emailVerified === true, nickname, preferredUsername, roles };
}
