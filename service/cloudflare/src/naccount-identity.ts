import { SESSION_SECONDS, unixNow, type Env, type UserRow } from "./contracts";
import { HttpError } from "./http";
import type { NaccountRuntimeConfig } from "./naccount-config";
import type { VerifiedNaccountProfile } from "./naccount-oidc";
import { randomToken, tokenHash } from "./security";

const NACCOUNT_SENTINEL_HASH = "naccount$managed";
const CODE_FENCE_TTL = 600;

export async function assertNaccountSchema(env: Env): Promise<void> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('user_naccount_identities', 'naccount_auth_codes')`,
  ).first<{ count: number }>();
  if ((row?.count ?? 0) !== 2) throw new HttpError(503, "naccount_schema_required");
}

export async function claimNaccountAuthCode(env: Env, config: NaccountRuntimeConfig, code: string): Promise<void> {
  const now = unixNow();
  const hash = await tokenHash(`naccount-code:${config.clientId}:${code}`);
  await env.DB.prepare(
    `DELETE FROM naccount_auth_codes WHERE code_hash IN (SELECT code_hash FROM naccount_auth_codes WHERE expires_at <= ? LIMIT 128)`,
  ).bind(now).run();
  try {
    await env.DB.prepare("INSERT INTO naccount_auth_codes(code_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .bind(hash, now, now + CODE_FENCE_TTL).run();
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE constraint failed")) {
      throw new HttpError(409, "naccount_code_already_used");
    }
    throw error;
  }
}

function normalizeCandidate(raw: string | null, reservedUsername: string): string | null {
  if (!raw) return null;
  const cleaned = raw.trim().toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[^a-z0-9]+$/, "")
    .slice(0, 48);
  if (cleaned.length < 3 || cleaned === reservedUsername || !/^[a-z0-9][a-z0-9._-]{2,63}$/.test(cleaned)) return null;
  return cleaned;
}

function candidateUsernames(profile: VerifiedNaccountProfile, reservedUsername: string): string[] {
  const emailLocal = profile.email?.includes("@") ? profile.email.split("@")[0] : null;
  const candidates = [
    normalizeCandidate(profile.preferredUsername, reservedUsername),
    normalizeCandidate(profile.nickname, reservedUsername),
    normalizeCandidate(emailLocal, reservedUsername),
  ].filter((value): value is string => value !== null);
  return [...new Set(candidates)];
}

function fallbackUsernameBase(profile: VerifiedNaccountProfile, reservedUsername: string): string {
  const subToken = profile.sub.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "user";
  return normalizeCandidate(`na-${subToken}`, reservedUsername) ?? `na-${crypto.randomUUID().slice(0, 8)}`;
}

function sessionStatements(env: Env, sessionHash: string, userId: string, now: number, grantSuperAdmin: boolean): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (grantSuperAdmin) {
    statements.push(
      env.DB.prepare("INSERT OR IGNORE INTO platform_admins(user_id, created_at) SELECT id, ? FROM users WHERE id = ? AND status = 'active'")
        .bind(now, userId),
    );
  }
  statements.push(
    env.DB.prepare(
      `INSERT INTO sessions(token_hash, user_id, created_at, expires_at)
       SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')`,
    ).bind(sessionHash, userId, now, now + SESSION_SECONDS, userId),
    env.DB.prepare(
      `DELETE FROM sessions WHERE user_id = ? AND token_hash IN
       (SELECT token_hash FROM sessions WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET 20)
       AND EXISTS (SELECT 1 FROM sessions WHERE token_hash = ?)`,
    ).bind(userId, userId, sessionHash),
  );
  return statements;
}

async function issueBoundSession(
  env: Env,
  existing: UserRow,
  profile: VerifiedNaccountProfile,
  displayName: string | null,
  grantSuperAdmin: boolean,
): Promise<{ user: { id: string; username: string }; token: string; expiresAt: number }> {
  if (existing.status !== "active") throw new HttpError(403, "account_disabled");
  const now = unixNow();
  const token = randomToken("es_");
  const sessionHash = await tokenHash(token);
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE user_naccount_identities SET email = ?, display_name = ?, updated_at = ? WHERE naccount_sub = ? AND user_id = ?")
      .bind(profile.email, displayName, now, profile.sub, existing.id),
    ...sessionStatements(env, sessionHash, existing.id, now, grantSuperAdmin),
  ]);
  const sessionInsertIndex = grantSuperAdmin ? 2 : 1;
  if (!results[sessionInsertIndex]?.meta.changes) throw new HttpError(403, "account_disabled");
  return { user: { id: existing.id, username: existing.username }, token, expiresAt: now + SESSION_SECONDS };
}

export async function completeNaccountSession(
  env: Env,
  config: NaccountRuntimeConfig,
  profile: VerifiedNaccountProfile,
): Promise<{ user: { id: string; username: string }; token: string; expiresAt: number }> {
  const displayName = profile.nickname ?? profile.preferredUsername ?? null;
  const grantSuperAdmin = profile.roles.includes("super_admin");
  const bound = await env.DB.prepare(
    `SELECT u.id, u.username, u.password_hash, u.status
     FROM user_naccount_identities i JOIN users u ON u.id = i.user_id WHERE i.naccount_sub = ?`,
  ).bind(profile.sub).first<UserRow>();
  if (bound) return issueBoundSession(env, bound, profile, displayName, grantSuperAdmin);

  const candidates = candidateUsernames(profile, config.bootstrapAdminUsername);
  for (const candidate of candidates) {
    const unlinked = await env.DB.prepare(
      `SELECT u.id, u.username, u.password_hash, u.status FROM users u
       WHERE lower(u.username) = ? AND lower(u.username) <> ?
         AND NOT EXISTS (SELECT 1 FROM user_naccount_identities i WHERE i.user_id = u.id)`,
    ).bind(candidate, config.bootstrapAdminUsername).first<UserRow>();
    if (!unlinked) continue;
    if (unlinked.status !== "active") throw new HttpError(403, "account_disabled");
    const now = unixNow();
    const token = randomToken("es_");
    const sessionHash = await tokenHash(token);
    const linkResults = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO user_naccount_identities(naccount_sub, user_id, email, display_name, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND status = 'active')
           AND NOT EXISTS (SELECT 1 FROM user_naccount_identities WHERE naccount_sub = ? OR user_id = ?)`,
      ).bind(profile.sub, unlinked.id, profile.email, displayName, now, now, unlinked.id, profile.sub, unlinked.id),
      env.DB.prepare(
        `UPDATE users SET password_hash = ? WHERE id = ?
         AND EXISTS (SELECT 1 FROM user_naccount_identities WHERE naccount_sub = ? AND user_id = ?)`,
      ).bind(NACCOUNT_SENTINEL_HASH, unlinked.id, profile.sub, unlinked.id),
      ...sessionStatements(env, sessionHash, unlinked.id, now, grantSuperAdmin),
    ]);
    if (linkResults[0]?.meta.changes) {
      return { user: { id: unlinked.id, username: unlinked.username }, token, expiresAt: now + SESSION_SECONDS };
    }
    const raced = await env.DB.prepare(
      `SELECT u.id, u.username, u.password_hash, u.status
       FROM user_naccount_identities i JOIN users u ON u.id = i.user_id WHERE i.naccount_sub = ?`,
    ).bind(profile.sub).first<UserRow>();
    if (raced) return issueBoundSession(env, raced, profile, displayName, grantSuperAdmin);
  }

  const base = candidates[0] ?? fallbackUsernameBase(profile, config.bootstrapAdminUsername);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const suffix = attempt === 0 ? "" : `-${crypto.randomUUID().replace(/-/g, "").slice(0, 6)}`;
    const username = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    const userId = crypto.randomUUID();
    const now = unixNow();
    const token = randomToken("es_");
    const sessionHash = await tokenHash(token);
    try {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO users(id, username, password_hash, created_at) VALUES (?, ?, ?, ?)")
          .bind(userId, username, NACCOUNT_SENTINEL_HASH, now),
        env.DB.prepare(
          "INSERT INTO user_naccount_identities(naccount_sub, user_id, email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
        ).bind(profile.sub, userId, profile.email, displayName, now, now),
        ...sessionStatements(env, sessionHash, userId, now, grantSuperAdmin),
      ]);
      return { user: { id: userId, username }, token, expiresAt: now + SESSION_SECONDS };
    } catch (error) {
      const raced = await env.DB.prepare(
        `SELECT u.id, u.username, u.password_hash, u.status
         FROM user_naccount_identities i JOIN users u ON u.id = i.user_id WHERE i.naccount_sub = ?`,
      ).bind(profile.sub).first<UserRow>();
      if (raced) return issueBoundSession(env, raced, profile, displayName, grantSuperAdmin);
      if (error instanceof Error && error.message.includes("UNIQUE constraint failed: users.username")) continue;
      throw error;
    }
  }
  throw new HttpError(409, "username_unavailable");
}
