import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireSession, requireScope } from "./identity";
import { normalRevision } from "./normal-account-input";
import { tokenHash } from "./security";
import { googleConfig } from "./google-oauth-config";
import { completeGoogleOAuth } from "./google-oauth-complete";
import { startGoogleOAuth } from "./google-oauth-start";
import { disconnectGoogleOAuth } from "./google-oauth-disconnect";
import { googleTargets, targetForGoogleState } from "./google-oauth-target";

const validState = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
const validCode = (value: unknown): value is string => typeof value === "string" && /^[\x21-\x7e]{1,2048}$/.test(value);
export const isGoogleOAuthPath = (path: string) => path === "/api/v1/oauth/google/complete"
  || /^\/api\/v1\/(?:normal|agent)-accounts\/[0-9a-f-]{36}\/oauth\/google\/(start|disconnect|status)$/.test(path);
export async function googleCallback(request: Request, env: Env) {
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  const url = new URL(request.url), fields = url.searchParams;
  if (url.href.length > 8192 || [...fields.keys()].some(key => !["state", "code", "error", "error_description", "error_uri", "scope", "authuser", "prompt", "hd", "iss"].includes(key)
    || fields.getAll(key).length !== 1) || !validState(fields.get("state"))
    || (fields.has("code") === fields.has("error")) || (fields.has("code") && !validCode(fields.get("code")))
    || (fields.has("iss") && fields.get("iss") !== "https://accounts.google.com")) throw new HttpError(400, "invalid_google_oauth_callback");
  const config = await googleConfig(env);
  const stateHash = await tokenHash(fields.get("state")!), targetScope = await targetForGoogleState(env, stateHash);
  const found = await env.DB.prepare(`SELECT id FROM ${targetScope.attempts} WHERE state_hash=? AND expires_at>unixepoch()`)
    .bind(stateHash).first();
  if (!found) throw new HttpError(400, "invalid_google_oauth_callback");
  const target = new URL("/", config.redirectUri);
  target.hash = new URLSearchParams({ "ee-google-state": fields.get("state")!,
    ...(fields.has("code") ? { "ee-google-code": fields.get("code")! } : { "ee-google-denied": "1" }) }).toString();
  return new Response(null, { status: 303, headers: { location: target.href } });
}
export async function googleOAuthRoute(request: Request, env: Env, identity: Identity) {
  const path = new URL(request.url).pathname;
  const target = path.startsWith("/api/v1/agent-accounts/") ? googleTargets.agent : googleTargets.normal;
  if (path.endsWith("/status") && request.method === "GET") {
    requireScope(identity, target.scope === "agent" ? "agent-accounts:read" : "mail-accounts:read");
    const accountId = path.split("/")[4], account = await target.account(env, identity.userId, accountId);
    if (!account || account.deleted_at !== null || account.authentication !== "google-oauth2") throw new HttpError(404, "not_found");
    const grant = account.oauth_grant_id ? await env.DB.prepare(`SELECT state FROM ${target.grants} WHERE id=? AND user_id=? AND account_id=?`)
      .bind(account.oauth_grant_id, identity.userId, accountId).first<{ state: string }>() : null;
    return json({ state: grant?.state ?? "not_authorized", accountRevision: account.revision, remoteRevocation: "not_requested" });
  }
  requireSession(identity, request, env);
  if (request.method !== "POST" || path.endsWith("/status")) throw new HttpError(405, "method_not_allowed");
  const body = await readJson(request);
  if (path === "/api/v1/oauth/google/complete") {
    if (Object.keys(body).some(key => !["state", "code", "denied"].includes(key)) || !validState(body.state)
      || (body.code !== undefined && !validCode(body.code)) || (body.denied !== undefined && body.denied !== true)
      || ((body.code !== undefined) === (body.denied === true))) throw new HttpError(400, "invalid_google_oauth_request");
    const selected = await targetForGoogleState(env, await tokenHash(body.state), true);
    return json(await completeGoogleOAuth(env, identity, body.state, body.code as string | undefined, body.denied === true, selected));
  }
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_google_oauth_request");
  // Terminal Agent revisions may revoke authority, but may never create another authorization.
  const terminalDisconnect = target.scope === "agent" && path.endsWith("/disconnect") && body.expectedRevision === Number.MAX_SAFE_INTEGER;
  const revision = terminalDisconnect ? Number.MAX_SAFE_INTEGER : normalRevision(body), key = request.headers.get("idempotency-key") ?? "";
  if (!/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const match = /^\/api\/v1\/(?:normal|agent)-accounts\/([0-9a-f-]{36})\/oauth\/google\/(start|disconnect)$/.exec(path);
  if (!match) throw new HttpError(405, "method_not_allowed");
  return json(match[2] === "start" ? await startGoogleOAuth(env, identity, match[1], revision, key, target)
    : await disconnectGoogleOAuth(env, identity, match[1], revision, key, target));
}
