import { SESSION_COOKIE, unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";

export function requireOrigin(request: Request, env: Env): void {
  const origin = new URL(env.APP_ORIGIN);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== env.APP_ORIGIN || (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback))) {
    throw new Error("Invalid APP_ORIGIN configuration");
  }
  if (request.headers.get("origin") !== origin.origin) throw new HttpError(403, "origin_denied");
}

export async function authenticate(request: Request, env: Env): Promise<Identity> {
  const authorization = request.headers.get("authorization");
  let token: string;
  let kind: Identity["kind"];
  if (authorization !== null) {
    const match = /^Bearer (ee_[0-9a-f]{64})$/.exec(authorization);
    if (!match) throw new HttpError(401, "unauthorized");
    token = match[1];
    kind = "apiKey";
  } else {
    const cookies = (request.headers.get("cookie") ?? "").split(";")
      .map((part) => part.trim()).filter((part) => part.startsWith(`${SESSION_COOKIE}=`));
    if (cookies.length !== 1) throw new HttpError(401, "unauthorized");
    token = cookies[0].slice(SESSION_COOKIE.length + 1);
    if (!/^es_[0-9a-f]{64}$/.test(token)) throw new HttpError(401, "unauthorized");
    kind = "session";
  }
  const hash = await tokenHash(token);
  const source = kind === "session"
    ? `SELECT u.id, u.username, s.token_hash AS credential_id, '[]' AS scopes
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`
    : `SELECT u.id, u.username, k.id AS credential_id, k.scopes
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.token_hash = ? AND k.revoked_at IS NULL AND k.expires_at > ? AND u.status = 'active'`;
  const row = await env.DB.prepare(source).bind(hash, unixNow())
    .first<{ id: string; username: string; credential_id: string; scopes: string }>();
  if (!row) throw new HttpError(401, "unauthorized");
  return { userId: row.id, username: row.username, kind, credentialId: row.credential_id, scopes: JSON.parse(row.scopes) };
}

export function requireSession(identity: Identity, request: Request, env: Env): void {
  if (identity.kind !== "session") throw new HttpError(403, "session_required");
  if (!["GET", "HEAD"].includes(request.method)) requireOrigin(request, env);
}

export function requireScope(identity: Identity, scope: string): void {
  if (identity.kind === "apiKey" && !identity.scopes.includes(scope)) throw new HttpError(403, "insufficient_scope");
}

export function requireWriteScope(request: Request, env: Env, identity: Identity, scope: string): void {
  requireScope(identity, scope);
  if (identity.kind === "session") requireOrigin(request, env);
}

export function identityCredentialFence(identity: Identity) {
  const table = identity.kind === "session" ? "sessions" : "api_keys", credential = identity.kind === "session" ? "token_hash" : "id";
  return `EXISTS (SELECT 1 FROM ${table} c JOIN users u ON u.id=c.user_id WHERE c.${credential}=? AND c.user_id=?
    AND c.revoked_at IS NULL AND c.expires_at>unixepoch() AND u.status='active')`;
}
