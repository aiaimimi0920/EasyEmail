import type { Env } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";

export const GOOGLE_AUTHORIZATION = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
export const GOOGLE_USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
export const GOOGLE_SCOPE = "openid email https://mail.google.com/";
export async function googleConfig(env: Env) {
  const clientId = env.GOOGLE_OAUTH_CLIENT_ID, clientSecret = env.GOOGLE_OAUTH_CLIENT_SECRET;
  let origin: URL;
  try { origin = new URL(env.APP_ORIGIN); } catch { throw new HttpError(503, "google_oauth_unavailable"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== env.APP_ORIGIN || (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))
    || typeof clientId !== "string" || !/^[a-zA-Z0-9._-]{1,256}\.apps\.googleusercontent\.com$/.test(clientId)
    || typeof clientSecret !== "string" || !/^[\x21-\x7e]{1,256}$/.test(clientSecret)) throw new HttpError(503, "google_oauth_unavailable");
  const redirectUri = origin.origin + "/oauth/google/callback";
  return { clientId, clientSecret, redirectUri, hash: await tokenHash(JSON.stringify(["google-oauth-v1", clientId, clientSecret, redirectUri])) };
}
export type GoogleConfig = Awaited<ReturnType<typeof googleConfig>>;
export const base64url = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(""))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomOAuthValue = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
export const googleChallenge = async (verifier: string) => base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
export async function googleAuthorizationUrl(config: GoogleConfig, state: string, verifier: string, email: string) {
  const url = new URL(GOOGLE_AUTHORIZATION);
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code",
    scope: GOOGLE_SCOPE, access_type: "offline", prompt: "consent", state, login_hint: email,
    code_challenge_method: "S256", code_challenge: await googleChallenge(verifier) }).toString();
  return url.href;
}
