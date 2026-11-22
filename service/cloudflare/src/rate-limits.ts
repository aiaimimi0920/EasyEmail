import { unixNow, type Env } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";

export async function rateLimit(env: Env, category: string, subject: string, limit: number): Promise<void> {
  const now = unixNow();
  const bucket = await tokenHash(`${category}:${Math.floor(now / 60)}:${subject}`);
  const row = await env.DB.prepare(`
    INSERT INTO auth_rate_limits(bucket, attempts, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1
    RETURNING attempts
  `).bind(bucket, now + 120).first<{ attempts: number }>();
  if (!row || row.attempts > limit) throw new HttpError(429, "rate_limited");
}

export async function cleanupIdentity(env: Env): Promise<void> {
  const now = unixNow();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM auth_rate_limits WHERE bucket IN
      (SELECT bucket FROM auth_rate_limits WHERE expires_at < ? LIMIT 5000)`).bind(now),
    env.DB.prepare(`DELETE FROM sessions WHERE token_hash IN
      (SELECT token_hash FROM sessions WHERE expires_at < ? LIMIT 5000)`).bind(now),
  ]);
}
