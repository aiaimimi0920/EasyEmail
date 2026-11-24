import { sessionCookie } from "./auth";
import type { Env } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireOrigin } from "./identity";
import { publicAuthConfig, resolveNaccountConfig } from "./naccount-config";
import { assertNaccountSchema, claimNaccountAuthCode, completeNaccountSession } from "./naccount-identity";
import { exchangeNaccountCode, validAuthCode, validCodeVerifier } from "./naccount-oidc";
import { rateLimit } from "./rate-limits";

export function authConfigRoute(request: Request, env: Env): Response {
  if (request.method !== "GET") throw new HttpError(405, "method_not_allowed");
  return json({ auth: publicAuthConfig(env) });
}

export async function completeNaccountLogin(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  requireOrigin(request, env);
  const config = resolveNaccountConfig(env);
  if (!config) throw new HttpError(403, "naccount_unavailable");
  await assertNaccountSchema(env);
  await rateLimit(env, "auth-ip", request.headers.get("cf-connecting-ip") ?? "local", 30);
  const body = await readJson(request);
  if (Object.keys(body).some((key) => !["code", "codeVerifier", "redirectUri"].includes(key))
    || !validAuthCode(body.code)
    || !validCodeVerifier(body.codeVerifier)
    || typeof body.redirectUri !== "string"
    || body.redirectUri !== config.redirectUri) {
    throw new HttpError(400, "invalid_naccount_callback");
  }
  await claimNaccountAuthCode(env, config, body.code);
  const profile = await exchangeNaccountCode(config, body.code, body.codeVerifier);
  const session = await completeNaccountSession(env, config, profile);
  return json({ user: session.user, expiresAt: session.expiresAt }, 200, {
    "set-cookie": sessionCookie(session.token),
  });
}
