import type { Env } from "./contracts";
import { HttpError } from "./http";
import { normalAccount, normalContext } from "./normal-account-store";
import { normalAccountView, type NormalAccount } from "./normal-account-model";
import { agentAccount, agentAccountContext } from "./agent-account-store";
import { agentAccountView } from "./agent-account-model";

export type GoogleScope = "normal" | "agent";
export type GoogleAccount = NormalAccount;
// SQL identifiers are a closed, server-owned whitelist, never supplied by a request or stored provider.
export const googleTargets = {
  normal: { scope: "normal", accounts: "normal_accounts", parent: "normal_accounts", attempts: "google_oauth_attempts",
    grants: "google_oauth_grants", disconnects: "google_oauth_disconnects", smtp: "normal_smtp_configs",
    account: normalAccount, view: normalAccountView, context: normalContext, changed: "normal_account_changed" },
  agent: { scope: "agent", accounts: "agent_google_oauth_accounts", parent: "agent_accounts", attempts: "agent_google_oauth_attempts",
    grants: "agent_google_oauth_grants", disconnects: "agent_google_oauth_disconnects", smtp: "agent_smtp_configs",
    account: agentAccount, view: agentAccountView, context: agentAccountContext, changed: "agent_account_changed" },
} as const;
export type GoogleTarget = typeof googleTargets[GoogleScope];
export async function availableGoogleTargets(env: Env): Promise<GoogleTarget[]> {
  const expanded = await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_google_oauth_attempts'").first();
  return expanded ? [googleTargets.normal, googleTargets.agent] : [googleTargets.normal];
}
export async function targetForGoogleState(env: Env, stateHash: string, completion = false) {
  const matches: GoogleTarget[] = [];
  for (const target of await availableGoogleTargets(env))
    if (await env.DB.prepare(`SELECT 1 FROM ${target.attempts} WHERE state_hash=?`).bind(stateHash).first()) matches.push(target);
  // Collision or corrupt state is never resolved by trusting a client-selected account scope.
  if (matches.length !== 1) throw new HttpError(completion ? 404 : 400, completion ? "not_found" : "invalid_google_oauth_callback");
  return matches[0];
}
export function googleFlowStatement(env: Env, target: GoogleTarget, accountId: string, userId: string, flow: string, fence: string) {
  const table = target.scope === "agent" ? "agent_google_oauth_bindings" : target.parent;
  const column = target.scope === "agent" ? "account_id" : "id";
  return env.DB.prepare(`UPDATE ${table} SET oauth_flow_id=? WHERE ${column}=? AND user_id=? AND ${fence}`).bind(flow, accountId, userId, flow);
}
export function googleAccountStatements(env: Env, target: GoogleTarget, account: Pick<GoogleAccount, "id" | "user_id">, grantId: string | null,
  reference: string | null, now: number, fence: string, token: string) {
  const authorization = target.scope === "normal" ? ",oauth_grant_id=?,oauth_flow_id=NULL" : "";
  const nextRevision = target.scope === "agent" && !grantId ? "MIN(revision+1,9007199254740991)" : "revision+1";
  const statements = [env.DB.prepare(`UPDATE ${target.parent} SET credential_cipher=?,enabled=?,revision=${nextRevision},updated_at=?,
    test_token=NULL,test_lease_until=NULL,tested_at=NULL,test_error=NULL${grantId ? ",inbox_uid_validity=NULL,inbox_messages=NULL" : ""}${authorization}
    WHERE id=? AND user_id=? AND ${fence}`)
    .bind(reference, Number(!!grantId), now, ...(target.scope === "normal" ? [grantId] : []), account.id, account.user_id, token)];
  // Parent retirement triggers run first. Only then install the new isolated grant reference.
  if (target.scope === "agent") statements.push(env.DB.prepare(`UPDATE agent_google_oauth_bindings SET oauth_grant_id=?,oauth_flow_id=NULL
    WHERE account_id=? AND user_id=? AND ${fence}`).bind(grantId, account.id, account.user_id, token));
  return statements;
}
