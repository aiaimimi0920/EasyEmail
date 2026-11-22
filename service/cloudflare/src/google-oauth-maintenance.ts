import type { Env } from "./contracts";
import { availableGoogleTargets } from "./google-oauth-target";

export async function maintainGoogleOAuth(env: Env) {
  for (const target of await availableGoogleTargets(env)) await env.DB.batch([
    env.DB.prepare(`UPDATE ${target.attempts} SET state='failed',secret_cipher=NULL,error_code='google_oauth_expired'
      WHERE (state='pending' AND expires_at<=unixepoch()) OR (state='exchanging' AND exchange_until<=unixepoch())`),
    env.DB.prepare(`UPDATE ${target.grants} SET state='reauthorize',secret_cipher=NULL,version=version+1,refresh_claim=NULL,refresh_until=NULL
      WHERE state='active' AND refresh_claim IS NOT NULL AND refresh_until<=unixepoch()`),
    env.DB.prepare(`DELETE FROM ${target.attempts} WHERE expires_at<unixepoch()-86400 AND state IN ('completed','failed')`),
  ]);
}
