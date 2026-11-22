import { unixNow } from "./contracts";
import { HttpError } from "./http";
import { GOOGLE_TOKEN, GOOGLE_USERINFO, type GoogleConfig } from "./google-oauth-config";
import { assertMailAuthentication } from "./mail-authentication";

export interface GoogleTokens { accessToken: string; refreshToken: string; expiresAt: number; refreshExpiresAt?: number; subject: string }
async function responseJson(response: Response) {
  if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new HttpError(502, "google_oauth_provider_failed"); }
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    await response.body?.cancel(); throw new HttpError(502, "google_oauth_provider_failed");
  }
  const reader = response.body?.getReader(); if (!reader) throw new HttpError(502, "google_oauth_provider_failed");
  try {
    let length = 0; const chunks: Uint8Array[] = [];
    while (true) { const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 16384) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    const bytes = new Uint8Array(length); let offset = 0; for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(502, "google_oauth_provider_failed"); }
  finally { reader.releaseLock(); }
}
function tokenText(value: unknown): value is string { return typeof value === "string" && value.length <= 4096 && /^[A-Za-z0-9._~+/-]+=*$/.test(value); }
function parseTokens(value: Record<string, unknown>, previous?: GoogleTokens): GoogleTokens {
  const lifetime = value.expires_in, refresh = value.refresh_token ?? previous?.refreshToken;
  if (value.token_type !== "Bearer" || !tokenText(value.access_token) || !tokenText(refresh)
    || !Number.isSafeInteger(lifetime) || (lifetime as number) < 60 || (lifetime as number) > 86400
    || (value.scope === undefined ? !previous : typeof value.scope !== "string" || !value.scope.split(" ").includes("https://mail.google.com/"))
    || (value.refresh_token_expires_in !== undefined && (!Number.isSafeInteger(value.refresh_token_expires_in)
      || (value.refresh_token_expires_in as number) < 60 || (value.refresh_token_expires_in as number) > 315360000)))
    throw new HttpError(502, "google_oauth_token_invalid");
  assertMailAuthentication("oauth", { method: "xoauth2", accessToken: value.access_token });
  return { accessToken: value.access_token, refreshToken: refresh, expiresAt: unixNow() + (lifetime as number), subject: previous?.subject ?? "",
    ...(value.refresh_token_expires_in !== undefined ? { refreshExpiresAt: unixNow() + (value.refresh_token_expires_in as number) }
      : previous?.refreshExpiresAt ? { refreshExpiresAt: previous.refreshExpiresAt } : {}) };
}
// One bounded attempt, no redirects or automatic retries. The deadline covers token + identity bodies.
async function googleRequest<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new HttpError(504, "google_oauth_outcome_unknown")); }, 10000); });
  try { return await Promise.race([work(controller.signal), deadline]); }
  catch (error) { throw error instanceof HttpError ? error : new HttpError(502, "google_oauth_provider_failed"); }
  finally { clearTimeout(timer!); controller.abort(); }
}
async function tokenRequest(config: GoogleConfig, fields: Record<string, string>, signal: AbortSignal, previous?: GoogleTokens) {
  const response = await fetch(GOOGLE_TOKEN, { method: "POST", redirect: "manual", signal,
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...fields, client_id: config.clientId, client_secret: config.clientSecret }).toString() });
  const value = await responseJson(response);
  if (!response.ok) throw new HttpError(502, value.error === "invalid_grant" ? "google_oauth_reauthorization_required" : "google_oauth_provider_failed");
  return parseTokens(value, previous);
}
export const exchangeGoogleCode = (config: GoogleConfig, code: string, verifier: string, expectedEmail: string) => googleRequest(async signal => {
  const tokens = await tokenRequest(config, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: config.redirectUri }, signal);
  if (signal.aborted) throw new HttpError(504, "google_oauth_outcome_unknown");
  const response = await fetch(GOOGLE_USERINFO, { method: "GET", redirect: "manual", signal,
    headers: { authorization: `Bearer ${tokens.accessToken}`, accept: "application/json" } });
  const user = await responseJson(response);
  if (!response.ok || typeof user.sub !== "string" || !/^[a-zA-Z0-9_-]{1,255}$/.test(user.sub)
    || user.email_verified !== true || typeof user.email !== "string" || user.email.toLowerCase() !== expectedEmail)
    throw new HttpError(409, "google_oauth_identity_mismatch");
  return { ...tokens, subject: user.sub };
});
export const refreshGoogleTokens = (config: GoogleConfig, previous: GoogleTokens) => googleRequest(signal =>
  tokenRequest(config, { grant_type: "refresh_token", refresh_token: previous.refreshToken }, signal, previous));
