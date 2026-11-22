import { SESSION_COOKIE, SESSION_SECONDS, unixNow, type Env, type Identity, type UserRow } from "./contracts";
import { HttpError, json, readJson, textField } from "./http";
import { requireOrigin, requireSession } from "./identity";
import { rateLimit } from "./rate-limits";
import { hashPassword, randomToken, secretEquals, tokenHash, verifyPassword } from "./security";

export function sessionCookie(token: string, age = SESSION_SECONDS): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

function credentials(body: Record<string, unknown>, registering: boolean): { username: string; password: string } {
  const username = textField(body, "username", 3, 64).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(username)) throw new HttpError(400, "invalid_username");
  const password = textField(body, "password", registering ? 15 : 1, 128);
  if (new TextEncoder().encode(password).length > 512) throw new HttpError(400, "invalid_password");
  return { username, password };
}

function insertSession(env: Env, hash: string, userId: string, now: number, passwordHash: string): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO sessions(token_hash, user_id, created_at, expires_at) SELECT ?,?,?,?
    WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND status='active' AND password_hash=?)`)
    .bind(hash, userId, now, now + SESSION_SECONDS, userId, passwordHash);
}

function pruneSessions(env: Env, userId: string, hash: string): D1PreparedStatement {
  return env.DB.prepare(`DELETE FROM sessions WHERE user_id = ? AND token_hash IN
    (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 20)
    AND EXISTS (SELECT 1 FROM sessions WHERE token_hash=?)`).bind(userId, userId, hash);
}

export async function signIn(request: Request, env: Env, registering: boolean): Promise<Response> {
  requireOrigin(request, env);
  await rateLimit(env, "auth-ip", request.headers.get("cf-connecting-ip") ?? "local", 30);
  const body = await readJson(request);
  const { username, password } = credentials(body, registering);
  await rateLimit(env, "auth-account", username, 5);
  const now = unixNow();
  const token = randomToken("es_");
  const hash = await tokenHash(token);
  let userId: string;
  if (registering) {
    if (!env.REGISTRATION_TOKEN || env.REGISTRATION_TOKEN.length < 32) {
      throw new HttpError(403, "registration_closed");
    }
    const invite = textField(body, "invite", 1, 256);
    if (!await secretEquals(invite, env.REGISTRATION_TOKEN)) throw new HttpError(403, "invalid_invite");
    userId = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .bind(userId, username, passwordHash, now),
        insertSession(env, hash, userId, now, passwordHash),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.username")) {
        throw new HttpError(409, "username_unavailable");
      }
      throw error;
    }
  } else {
    const user = await env.DB.prepare("SELECT id, username, password_hash, status FROM users WHERE username = ?")
      .bind(username).first<UserRow>();
    const verified = await verifyPassword(password, user?.password_hash);
    if (!verified || !user || user.status !== "active") throw new HttpError(401, "invalid_credentials");
    userId = user.id;
    const results = await env.DB.batch([
      insertSession(env, hash, userId, now, user.password_hash),
      pruneSessions(env, userId, hash),
    ]);
    if (!results[0].meta.changes) throw new HttpError(401, "invalid_credentials");
  }
  return json({ user: { id: userId, username }, expiresAt: now + SESSION_SECONDS }, registering ? 201 : 200,
    { "set-cookie": sessionCookie(token) });
}

export async function logout(request: Request, env: Env, identity: Identity): Promise<Response> {
  requireSession(identity, request, env);
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ?")
    .bind(unixNow(), identity.credentialId, identity.userId).run();
  return json({ success: true }, 200, { "set-cookie": sessionCookie("", 0) });
}
