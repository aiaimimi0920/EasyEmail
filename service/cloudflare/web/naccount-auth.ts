import { api, ApiError, type User } from "./api";

export interface NaccountAuthConfig {
  mode: "naccount";
  issuer: string;
  clientId: string;
  redirectUri: string;
  accountUrl: string;
  logoutUrl: string;
  postLogoutRedirectUri: string;
}

export type AuthConfig = { mode: "local" } | NaccountAuthConfig;

type CapturedCallback =
  | { kind: "invalid" }
  | { kind: "error"; state: string; error: string }
  | { kind: "code"; state: string; code: string; iss: string | null };

interface StoredTransaction {
  state: string;
  verifier: string;
  createdAt: number;
  clientId: string;
  redirectUri: string;
}

const MAX_TRANSACTION_AGE_MS = 10 * 60 * 1000;
const ALLOWED_CALLBACK_KEYS = ["code", "state", "error", "error_description", "error_uri", "iss"];

function randomHex(bytes = 32): string {
  return Array.from(
    crypto.getRandomValues(new Uint8Array(bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function captureInitialCallback(): CapturedCallback | null {
  if (window.location.pathname === "/" && window.location.search) {
    try {
      const logoutState = sessionStorage.getItem("naccount.logout");
      if (logoutState !== null) {
        sessionStorage.removeItem("naccount.logout");
        const params = new URLSearchParams(window.location.search);
        if (params.get("state") === logoutState && [...params.keys()].every((key) => key === "state")) {
          window.history.replaceState(window.history.state, "", "/");
        }
      }
    } catch { /* Ignore unavailable storage during logout return cleanup. */ }
    return null;
  }
  if (window.location.pathname !== "/auth/callback") return null;
  const search = window.location.search;
  window.history.replaceState(window.history.state, "", "/");
  if (!search || search.length > 8192) return { kind: "invalid" };
  const fields = new URLSearchParams(search);
  const keys = [...fields.keys()];
  if (!keys.length
    || keys.some((key) => !ALLOWED_CALLBACK_KEYS.includes(key) || fields.getAll(key).length !== 1)
    || fields.has("code") === fields.has("error")) {
    return { kind: "invalid" };
  }
  const state = fields.get("state");
  if (!state || !/^[\x21-\x7e]{16,256}$/.test(state)) return { kind: "invalid" };
  if (fields.has("error")) {
    return { kind: "error", state, error: fields.get("error") ?? "access_denied" };
  }
  const code = fields.get("code");
  if (!code || !/^[\x21-\x7e]{16,2048}$/.test(code)) return { kind: "invalid" };
  return { kind: "code", state, code, iss: fields.get("iss") };
}

let captured = captureInitialCallback();
let completionAttempt: Promise<User> | null = null;

export const hasNaccountReturn = () => captured !== null || completionAttempt !== null;

export function discardNaccountReturn(): void {
  captured = null;
}

export async function startNaccountLogin(config: NaccountAuthConfig, screen?: "signup" | "reset"): Promise<void> {
  const state = randomHex(32);
  const verifier = randomHex(32);
  const challenge = await pkceChallenge(verifier);
  const key = `naccount.transaction.${config.clientId}`;
  const transaction: StoredTransaction = {
    state,
    verifier,
    createdAt: Date.now(),
    clientId: config.clientId,
    redirectUri: config.redirectUri,
  };
  sessionStorage.setItem(key, JSON.stringify(transaction));
  const url = new URL("/login", config.issuer);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    locale: "zh",
  }).toString();
  if (screen === "signup" || screen === "reset") url.searchParams.set("screen", screen);
  window.location.assign(url.href);
}

export function completeNaccountReturn(config: NaccountAuthConfig): Promise<User> {
  if (completionAttempt) return completionAttempt;
  const current = captured;
  captured = null;
  completionAttempt = (async () => {
    const key = `naccount.transaction.${config.clientId}`;
    let raw: string | null = null;
    try {
      raw = sessionStorage.getItem(key);
    } finally {
      try { sessionStorage.removeItem(key); } catch { /* Best-effort transaction cleanup. */ }
    }
    if (!current || current.kind === "invalid" || !raw) {
      throw new ApiError(400, "invalid_naccount_callback");
    }
    let stored: Partial<StoredTransaction>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid");
      stored = parsed as Partial<StoredTransaction>;
    } catch {
      throw new ApiError(400, "invalid_naccount_callback");
    }
    if (stored.clientId !== config.clientId
      || stored.redirectUri !== config.redirectUri
      || typeof stored.state !== "string"
      || stored.state !== current.state
      || typeof stored.verifier !== "string"
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(stored.verifier)
      || typeof stored.createdAt !== "number"
      || !Number.isFinite(stored.createdAt)) {
      throw new ApiError(400, "invalid_naccount_callback");
    }
    const age = Date.now() - stored.createdAt;
    if (age < -5_000 || age > MAX_TRANSACTION_AGE_MS) {
      throw new ApiError(400, "naccount_login_expired");
    }
    if (current.kind === "error") {
      throw new ApiError(400, current.error === "access_denied" ? "naccount_access_denied" : "naccount_provider_denied");
    }
    if (current.iss !== null && current.iss !== config.issuer) {
      throw new ApiError(400, "invalid_naccount_callback");
    }
    await api<{ user: User }>("/auth/naccount/complete", "POST", {
      code: current.code,
      codeVerifier: stored.verifier,
      redirectUri: config.redirectUri,
    });
    return (await api<{ user: User }>("/me")).user;
  })();
  return completionAttempt;
}

export function buildNaccountLogoutUrl(config: NaccountAuthConfig): string {
  const state = randomHex(16);
  try { sessionStorage.setItem("naccount.logout", state); } catch { /* Optional logout state correlation. */ }
  const url = new URL(config.logoutUrl);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    state,
  }).toString();
  return url.href;
}
