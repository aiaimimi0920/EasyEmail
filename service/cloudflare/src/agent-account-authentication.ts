import type { Env } from "./contracts";

// Pre-0051 readers/writers retain their password contract. New OAuth operations require the expanded schema.
export async function agentAccountTable(env: Env) {
  const expanded = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='agent_google_oauth_accounts'").first();
  return expanded ? "agent_google_oauth_accounts" : "agent_accounts";
}
