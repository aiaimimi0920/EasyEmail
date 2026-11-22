import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { agentAccount, agentAccountCredentialFence } from "./agent-account-store";
import { agentInboxSourceHash } from "./agent-inbox-claim";
import { imapEndpoint } from "./normal-account-input";
import { tokenHash } from "./security";
import { rateLimit } from "./rate-limits";
import { agentEndpointMatches } from "./agent-mail-authentication";
import { autoInboxOperationView, type AutoInboxCommand, type AutoInboxOperation, type AutoInboxRow } from "./agent-auto-inbox-model";

export const autoInboxRow = (env: Env, userId: string, id: string) => env.DB.prepare("SELECT * FROM agent_inbox_automation WHERE user_id=? AND account_id=?").bind(userId, id).first<AutoInboxRow>();
export const autoInboxOperation = (env: Env, identity: Identity, key: string) => env.DB.prepare(`SELECT * FROM agent_inbox_automation_operations WHERE user_id=? AND request_key=? AND ${agentAccountCredentialFence(identity)}`)
  .bind(identity.userId, key, identity.credentialId, identity.userId).first<AutoInboxOperation>();
async function accountFor(env: Env, userId: string, id: string) {
  const row = await agentAccount(env, userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found"); return row;
}
export async function autoInboxConfig(env: Env, userId: string, id: string) {
  const account = await accountFor(env, userId, id), row = await autoInboxRow(env, userId, id);
  let endpointReady = false;
  try { const endpoint = await imapEndpoint(env, account.endpoint_id); endpointReady = endpoint.hash === account.endpoint_hash && agentEndpointMatches(account, endpoint); } catch { /* Fail closed on unavailable endpoint configuration. */ }
  const ready = !!(row?.enabled && row.next_due_at !== null && row.account_revision === account.revision && account.enabled && account.credential_cipher && endpointReady && env.INBOX
    && row.source_hash === await agentInboxSourceHash(account));
  const expired = row?.last_state === "running" && (row.lease_until ?? 0) <= Math.floor(Date.now() / 1000);
  return { accountId: id, accountRevision: account.revision, revision: row?.revision ?? 0, boundAccountRevision: row?.account_revision ?? 0,
    enabled: !!row?.enabled, intervalMinutes: row?.interval_minutes ?? 15, ready, nextDueAt: ready ? row?.next_due_at ?? null : null,
    lastState: expired ? "interrupted" : row?.last_state ?? "idle", lastErrorCode: expired ? "agent_inbox_interrupted" : row?.last_error_code ?? null,
    lastRequestKey: row?.last_request_key ?? null, lastStartedAt: row?.last_started_at ?? null, lastFinishedAt: row?.last_finished_at ?? null };
}
export async function writeAutoInbox(env: Env, identity: Identity, id: string, key: string, command: AutoInboxCommand) {
  const digest = await tokenHash(JSON.stringify([id, command.expectedAccountRevision, command.expectedRevision, command.enabled, command.intervalMinutes, command.persistentAuthorization]));
  async function replay(row: AutoInboxOperation) {
    if (row.request_hash !== digest) throw new HttpError(409, "idempotency_conflict"); return autoInboxOperationView(row);
  }
  const prior = await autoInboxOperation(env, identity, key); if (prior) return replay(prior);
  const account = await accountFor(env, identity.userId, id), current = await autoInboxRow(env, identity.userId, id);
  if (account.revision !== command.expectedAccountRevision || (current?.revision ?? 0) !== command.expectedRevision) {
    const raced = await autoInboxOperation(env, identity, key); if (raced) return replay(raced);
    throw new HttpError(409, "agent_auto_inbox_changed");
  }
  if (command.enabled) {
    const endpoint = await imapEndpoint(env, account.endpoint_id);
    if (!account.enabled || !account.credential_cipher || endpoint.hash !== account.endpoint_hash || !agentEndpointMatches(account, endpoint)) throw new HttpError(409, "agent_inbox_changed");
    if (!env.INBOX) throw new HttpError(503, "agent_inbox_not_configured");
  }
  const sourceHash = await agentInboxSourceHash(account), op = crypto.randomUUID(), revision = command.expectedRevision + 1;
  const accountFence = `EXISTS(SELECT 1 FROM agent_accounts WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL
    AND (?=0 OR enabled=1 AND credential_cipher IS NOT NULL) AND endpoint_hash=? AND username=? AND email_address=?)`;
  const target = `COALESCE((SELECT revision FROM agent_inbox_automation WHERE account_id=? AND user_id=?),0)=?`;
  const pending = "EXISTS(SELECT 1 FROM agent_inbox_automation_operations WHERE id=? AND completed_at IS NULL)";
  try {
    await rateLimit(env, "agent-auto-inbox-config", identity.userId, 10);
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO agent_inbox_automation_operations(id,user_id,account_id,request_key,request_hash,account_revision,expected_revision,revision,enabled,interval_minutes)
        SELECT ?,?,?,?,?,?,?,?,?,? WHERE ${accountFence} AND ${target} AND ${agentAccountCredentialFence(identity)}
        AND (?=0 OR (SELECT COUNT(*) FROM agent_inbox_automation_operations WHERE user_id=?)<10000) ON CONFLICT(user_id,request_key) DO NOTHING`)
        .bind(op, identity.userId, id, key, digest, account.revision, command.expectedRevision, revision, Number(command.enabled), command.intervalMinutes,
          id, identity.userId, account.revision, Number(command.enabled), account.endpoint_hash, account.username, account.email_address,
          id, identity.userId, command.expectedRevision, identity.credentialId, identity.userId, Number(command.enabled), identity.userId),
      env.DB.prepare(`INSERT INTO agent_inbox_automation(account_id,user_id,revision,account_revision,source_hash,enabled,interval_minutes,next_due_at,updated_at)
        SELECT ?,?,?,?,?,?,?,CASE WHEN ?=1 THEN unixepoch() ELSE NULL END,unixepoch() WHERE ${pending}
        ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,account_revision=excluded.account_revision,source_hash=excluded.source_hash,
          enabled=excluded.enabled,interval_minutes=excluded.interval_minutes,next_due_at=excluded.next_due_at,updated_at=excluded.updated_at,
          run_token=NULL,run_request_id=NULL,lease_until=NULL,failures=0,last_state='idle',last_error_code=NULL,last_request_key=NULL,last_started_at=NULL,last_finished_at=NULL`)
        .bind(id, identity.userId, revision, account.revision, sourceHash, Number(command.enabled), command.intervalMinutes, Number(command.enabled), op),
      env.DB.prepare("UPDATE agent_inbox_automation_operations SET completed_at=unixepoch() WHERE id=? AND completed_at IS NULL").bind(op),
    ]);
  } catch (error) {
    const receipt = await autoInboxOperation(env, identity, key); if (receipt) return replay(receipt); throw error;
  }
  const receipt = await autoInboxOperation(env, identity, key); if (receipt) return replay(receipt);
  throw new HttpError(409, "agent_auto_inbox_changed");
}
