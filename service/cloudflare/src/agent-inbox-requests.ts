import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { rateLimit } from "./rate-limits";
import { agentAccount, agentAccountCredentialFence } from "./agent-account-store";
import { agentInboxAccountFence } from "./agent-inbox-claim";
import { AGENT_INBOX_CAPACITY } from "./agent-inbox-capacity";
import { syncAgentInbox } from "./agent-inbox-sync";

interface InboxRequest {
  id: string; account_id: string; request_key: string; account_revision: number; state: string; result_json: string | null;
  error_code: string | null; created_at: number; finished_at: number | null; current_revision: number;
  active_request: string | null; active_lease: number | null;
}
const query = `SELECT r.*,a.revision AS current_revision,s.request_id AS active_request,s.claim_lease_until AS active_lease
  FROM agent_inbox_requests r JOIN agent_accounts a ON a.id=r.account_id AND a.user_id=r.user_id
  LEFT JOIN agent_inbox_state s ON s.account_id=a.id
  WHERE a.id=? AND a.user_id=? AND a.deleted_at IS NULL`;
function view(row: InboxRequest) {
  const now = Math.floor(Date.now() / 1000), live = row.active_request === row.id && (row.active_lease ?? 0) > now;
  const interrupted = row.state === "pending" && (row.current_revision !== row.account_revision || !live && row.created_at + 90 <= now);
  return { id: row.id, requestKey: row.request_key, accountId: row.account_id, accountRevision: row.account_revision,
    state: interrupted ? "failed" : row.state, createdAt: row.created_at, finishedAt: row.finished_at,
    errorCode: interrupted ? "agent_inbox_interrupted" : row.error_code,
    result: row.state === "committed" && row.result_json ? JSON.parse(row.result_json) : null };
}
export async function getAgentInboxRequest(env: Env, identity: Identity, accountId: string, key: string) {
  requireScope(identity, "agent-inbox:read"); requireScope(identity, "agent-accounts:sync");
  const row = await env.DB.prepare(`${query} AND r.request_key=? AND ${agentAccountCredentialFence(identity)}`)
    .bind(accountId, identity.userId, key, identity.credentialId, identity.userId).first<InboxRequest>();
  if (!row) throw new HttpError(404, "not_found"); return view(row);
}
async function replay(env: Env, identity: Identity, accountId: string, revision: number, key: string) {
  const prior = await getAgentInboxRequest(env, identity, accountId, key).catch(error => {
    if (error instanceof HttpError && error.status === 404) return null; throw error;
  });
  if (prior && prior.accountRevision !== revision) throw new HttpError(409, "idempotency_conflict");
  return prior;
}
export async function requestAgentInbox(env: Env, identity: Identity, accountId: string, revision: number, key: string) {
  requireScope(identity, "agent-inbox:read"); requireScope(identity, "agent-accounts:sync");
  const previous = await replay(env, identity, accountId, revision, key); if (previous) return previous;
  const account = await agentAccount(env, identity.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  if (account.revision !== revision || !account.enabled || !account.credential_cipher) throw new HttpError(409, "agent_inbox_changed");
  const id = crypto.randomUUID(), live = agentInboxAccountFence(identity, accountId, revision);
  let inserted;
  try {
    await rateLimit(env, "agent-inbox-request", identity.userId, 10);
    await rateLimit(env, "agent-inbox-request-global", "platform", 60);
    inserted = await env.DB.prepare(`INSERT INTO agent_inbox_requests(id,user_id,account_id,request_key,account_revision,state,created_at)
      SELECT ?,?,?,?,?,'pending',unixepoch() WHERE ${live.sql} AND ${AGENT_INBOX_CAPACITY}
      ON CONFLICT(account_id,request_key) DO NOTHING`)
      .bind(id, identity.userId, accountId, key, revision, ...live.values, accountId, 1, 1).run();
  } catch (error) {
    // A lost INSERT acknowledgement may already own the key. Only query it; never reconnect on this path.
    const raced = await replay(env, identity, accountId, revision, key); if (raced) return raced; throw error;
  }
  if (!inserted.meta.changes) {
    const raced = await replay(env, identity, accountId, revision, key); if (raced) return raced;
    throw new HttpError(409, "agent_inbox_changed_or_limit");
  }
  try { await syncAgentInbox(env, identity, accountId, revision, id); }
  catch (error) {
    const code = error instanceof HttpError ? error.code : "agent_inbox_storage_failed";
    await env.DB.prepare("UPDATE agent_inbox_requests SET state='failed',finished_at=unixepoch(),error_code=? WHERE id=? AND state='pending'")
      .bind(code, id).run();
  }
  return getAgentInboxRequest(env, identity, accountId, key);
}
