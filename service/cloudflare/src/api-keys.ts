import { KEY_MAX_SECONDS, KEY_SCOPES, unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, pageOptions, readJson, textField } from "./http";
import { requireSession } from "./identity";
import { randomToken, tokenHash } from "./security";
import { ACTIVE_SESSION_FENCE, assertActiveSession } from "./session-security";

const COLUMNS = "id, name, prefix, scopes, created_at AS createdAt, expires_at AS expiresAt, revoked_at AS revokedAt";

export async function listKeys(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireSession(identity, request, env);
  const { limit, cursor } = pageOptions(new URL(request.url));
  const { results } = await env.DB.prepare(`SELECT ${COLUMNS} FROM api_keys
    WHERE user_id = ? AND id > ? ORDER BY id LIMIT ?`).bind(identity.userId, cursor, limit + 1)
    .all<{ id: string; scopes: string }>();
  const items = results.slice(0, limit).map((row) => ({ ...row, scopes: JSON.parse(row.scopes) }));
  return json({ items, nextCursor: results.length > limit ? items.at(-1)!.id : null });
}

export async function createKey(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireSession(identity, request, env);
  const body = await readJson(request);
  const name = textField(body, "name", 1, 80).trim();
  if (!name) throw new HttpError(400, "invalid_name");
  const scopes = body.scopes;
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > KEY_SCOPES.length
    || !scopes.every((scope) => KEY_SCOPES.includes(scope)) || new Set(scopes).size !== scopes.length) {
    throw new HttpError(400, "invalid_scopes");
  }
  const seconds = body.expiresInSeconds ?? 30 * 86400;
  if (!Number.isSafeInteger(seconds) || (seconds as number) < 60 || (seconds as number) > KEY_MAX_SECONDS) {
    throw new HttpError(400, "invalid_expiry");
  }
  const now = unixNow();
  const id = crypto.randomUUID();
  const token = randomToken("ee_");
  const prefix = token.slice(0, 11);
  const hash = await tokenHash(token);
  const result = await env.DB.prepare(`INSERT INTO api_keys
    (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE
    (SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?) < 20
    AND ${ACTIVE_SESSION_FENCE}`)
    .bind(id, identity.userId, name, hash, prefix, JSON.stringify(scopes), now, now + (seconds as number),
      identity.userId, now, identity.credentialId, identity.userId).run();
  if (!result.meta.changes) {
    await assertActiveSession(env, identity);
    throw new HttpError(409, "active_key_limit");
  }
  return json({ id, name, token, prefix, scopes, createdAt: now, expiresAt: now + (seconds as number) }, 201);
}

export async function revokeKey(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  requireSession(identity, request, env);
  const result = await env.DB.prepare(`UPDATE api_keys SET revoked_at = COALESCE(revoked_at, ?)
    WHERE id = ? AND user_id = ?`).bind(unixNow(), id, identity.userId).run();
  if (!result.meta.changes) throw new HttpError(404, "not_found");
  return json({ success: true });
}
