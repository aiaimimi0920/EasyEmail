import type { Env } from "./contracts";
import { HttpError } from "./http";
import { rateLimit } from "./rate-limits";
import { agentInboxSourceHash } from "./agent-inbox-claim";
import { agentInboxAccountFence, type AgentInboxAutomationAuthority } from "./agent-inbox-authority";
import { AGENT_INBOX_CAPACITY } from "./agent-inbox-capacity";
import { syncAgentInbox } from "./agent-inbox-sync";
import type { AutoInboxRow } from "./agent-auto-inbox-model";
import { imapEndpoint } from "./normal-account-input";

interface Candidate extends AutoInboxRow { endpoint_id: string; endpoint_hash: string; username: string; email_address: string }
const activeAccount = `EXISTS(SELECT 1 FROM agent_accounts a JOIN users u ON u.id=a.user_id
  WHERE a.id=? AND a.user_id=? AND a.revision=? AND a.enabled=1 AND a.deleted_at IS NULL AND a.credential_cipher IS NOT NULL
    AND a.endpoint_hash=? AND a.username=? AND a.email_address=? AND u.status='active')`;
const claimFree = `NOT EXISTS(SELECT 1 FROM agent_inbox_state WHERE account_id=? AND claim_token IS NOT NULL AND claim_lease_until>unixepoch())`;
async function expireRuns(env: Env) {
  const rows = (await env.DB.prepare(`SELECT c.account_id,c.revision,c.run_token,c.run_request_id,r.state AS request_state,r.error_code
    FROM agent_inbox_automation c LEFT JOIN agent_inbox_requests r ON r.id=c.run_request_id AND r.account_id=c.account_id AND r.user_id=c.user_id
    WHERE c.run_token IS NOT NULL AND c.lease_until<=unixepoch() ORDER BY c.lease_until,c.account_id LIMIT 20`)
    .all<Pick<AutoInboxRow, "account_id" | "revision" | "run_token" | "run_request_id"> & { request_state: string | null; error_code: string | null }>()).results;
  for (const row of rows) await env.DB.batch([
    env.DB.prepare(`UPDATE agent_inbox_requests SET state='failed',error_code='agent_inbox_interrupted',finished_at=unixepoch() WHERE id=? AND state='pending'
      AND EXISTS(SELECT 1 FROM agent_inbox_automation WHERE account_id=? AND revision=? AND run_token=? AND lease_until<=unixepoch())`)
      .bind(row.run_request_id, row.account_id, row.revision, row.run_token),
    env.DB.prepare(`UPDATE agent_inbox_automation SET run_token=NULL,run_request_id=NULL,lease_until=NULL,last_state=?,
      last_error_code=?,last_finished_at=unixepoch(),failures=CASE WHEN ?=1 THEN 0 ELSE MIN(failures+1,10) END,next_due_at=MAX(next_due_at,unixepoch()+60)
      WHERE account_id=? AND revision=? AND run_token=? AND lease_until<=unixepoch()`)
      .bind(row.request_state === "committed" ? "committed" : row.request_state === "failed" ? "failed" : "interrupted",
        row.request_state === "committed" ? null : row.error_code ?? "agent_inbox_interrupted", Number(row.request_state === "committed"), row.account_id, row.revision, row.run_token),
  ]);
}
async function reserve(env: Env, row: Candidate): Promise<AgentInboxAutomationAuthority | null> {
  let endpointReady = false;
  try { const endpoint = await imapEndpoint(env, row.endpoint_id); endpointReady = endpoint.hash === row.endpoint_hash; }
  catch { /* Endpoint configuration is not a transport failure or permission to switch sources. */ }
  if (!endpointReady || row.source_hash !== await agentInboxSourceHash(row)) {
    await env.DB.prepare(`UPDATE agent_inbox_automation SET next_due_at=NULL,last_error_code='agent_inbox_changed'
      WHERE account_id=? AND user_id=? AND revision=? AND account_revision=? AND source_hash=? AND next_due_at=? AND run_token IS NULL`)
      .bind(row.account_id, row.user_id, row.revision, row.account_revision, row.source_hash, row.next_due_at).run();
    return null;
  }
  const authority: AgentInboxAutomationAuthority = { kind: "automation", userId: row.user_id, accountId: row.account_id, accountRevision: row.account_revision,
    revision: row.revision, runToken: crypto.randomUUID(), requestId: crypto.randomUUID(), sourceHash: row.source_hash,
    endpointHash: row.endpoint_hash, username: row.username, emailAddress: row.email_address };
  const live = agentInboxAccountFence(authority, row.account_id, row.account_revision);
  try {
    await rateLimit(env, "agent-inbox-request", row.user_id, 10);
    await rateLimit(env, "agent-inbox-request-global", "platform", 60);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 429 && error.code === "rate_limited")) throw error;
    // Only a confirmed pre-reservation rejection can yield the due slot. Never guess after a lost write ACK.
    await env.DB.prepare(`UPDATE agent_inbox_automation SET next_due_at=unixepoch()+60
      WHERE account_id=? AND user_id=? AND revision=? AND account_revision=? AND source_hash=? AND enabled=1 AND next_due_at=? AND run_token IS NULL`)
      .bind(row.account_id, row.user_id, row.revision, row.account_revision, row.source_hash, row.next_due_at).run();
    return null;
  }
  const results = await env.DB.batch([
    env.DB.prepare(`UPDATE agent_inbox_automation SET run_token=?,run_request_id=?,lease_until=unixepoch()+90,next_due_at=unixepoch()+interval_minutes*60,
      last_started_at=unixepoch(),last_finished_at=NULL,last_request_key=?,last_state='running',last_error_code=NULL
      WHERE account_id=? AND user_id=? AND revision=? AND account_revision=? AND source_hash=? AND enabled=1
        AND next_due_at<=unixepoch() AND (run_token IS NULL OR lease_until<=unixepoch()) AND ${activeAccount} AND ${claimFree}`)
      .bind(authority.runToken, authority.requestId, authority.runToken, row.account_id, row.user_id, row.revision, row.account_revision, row.source_hash,
        row.account_id, row.user_id, row.account_revision, row.endpoint_hash, row.username, row.email_address, row.account_id),
    env.DB.prepare(`INSERT INTO agent_inbox_requests(id,user_id,account_id,request_key,account_revision,state,created_at)
      SELECT ?,?,?,?,?,'pending',unixepoch() WHERE ${live.sql} AND ${AGENT_INBOX_CAPACITY} ON CONFLICT(account_id,request_key) DO NOTHING`)
      .bind(authority.requestId, row.user_id, row.account_id, authority.runToken, row.account_revision, ...live.values, row.account_id, 1, 1),
    env.DB.prepare(`UPDATE agent_inbox_automation SET run_token=NULL,run_request_id=NULL,lease_until=NULL,last_state='failed',
      last_error_code='agent_inbox_changed_or_limit',last_finished_at=unixepoch(),failures=MIN(failures+1,10)
      WHERE account_id=? AND run_token=? AND NOT EXISTS(SELECT 1 FROM agent_inbox_requests WHERE id=?)`)
      .bind(row.account_id, authority.runToken, authority.requestId),
  ]);
  return results[1].meta.changes === 1 ? authority : null;
}
async function receive(env: Env, authority: AgentInboxAutomationAuthority) {
  try { await syncAgentInbox(env, authority, authority.accountId, authority.accountRevision, authority.requestId); }
  catch (error) {
    await env.DB.prepare("UPDATE agent_inbox_requests SET state='failed',error_code=?,finished_at=unixepoch() WHERE id=? AND state='pending'")
      .bind(error instanceof HttpError ? error.code : "agent_inbox_storage_failed", authority.requestId).run();
  }
  const receipt = await env.DB.prepare("SELECT state,error_code FROM agent_inbox_requests WHERE id=?").bind(authority.requestId).first<{ state: string; error_code: string | null }>();
  if (!receipt || receipt.state === "pending") return;
  const success = receipt.state === "committed", live = agentInboxAccountFence(authority, authority.accountId, authority.accountRevision);
  await env.DB.prepare(`UPDATE agent_inbox_automation SET last_state=?,last_error_code=?,last_finished_at=unixepoch(),
    failures=CASE WHEN ?=1 THEN 0 ELSE MIN(failures+1,10) END,
    next_due_at=CASE WHEN ?='agent_inbox_changed' THEN NULL ELSE unixepoch()+MIN(3600,interval_minutes*60*CASE WHEN ?=1 THEN 1 ELSE (1<<MIN(failures+1,4)) END) END,
    run_token=NULL,run_request_id=NULL,lease_until=NULL WHERE account_id=? AND revision=? AND run_token=? AND ${live.sql}`)
    .bind(success ? "committed" : "failed", receipt.error_code, Number(success), receipt.error_code, Number(success),
      authority.accountId, authority.revision, authority.runToken, ...live.values).run();
}
export async function runAgentAutoInbox(env: Env) {
  // Older schema fixtures and overlapping pre-0050 deployments do not acquire implicit receive authority.
  if (!await env.DB.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_inbox_automation'").first()) return;
  await expireRuns(env);
  const rows = (await env.DB.prepare(`SELECT c.*,a.endpoint_id,a.endpoint_hash,a.username,a.email_address FROM agent_inbox_automation c
    JOIN agent_accounts a ON a.id=c.account_id AND a.user_id=c.user_id JOIN users u ON u.id=c.user_id
    WHERE c.enabled=1 AND c.next_due_at IS NOT NULL AND c.next_due_at<=unixepoch() AND (c.run_token IS NULL OR c.lease_until<=unixepoch())
      AND a.revision=c.account_revision AND a.enabled=1 AND a.deleted_at IS NULL AND a.credential_cipher IS NOT NULL AND u.status='active'
      AND NOT EXISTS(SELECT 1 FROM agent_inbox_state s WHERE s.account_id=c.account_id AND s.claim_token IS NOT NULL AND s.claim_lease_until>unixepoch())
    ORDER BY c.next_due_at,c.account_id LIMIT 3`).all<Candidate>()).results;
  for (const row of rows) {
    try { const authority = await reserve(env, row); if (authority) await receive(env, authority); }
    catch (error) {
      // Lost reservation ACK: never connect or replay this run; expiry reconciles only this exact receipt.
      if (!(error instanceof HttpError && error.status === 429)) console.error(JSON.stringify({ code: "agent_auto_inbox_unconfirmed" }));
    }
  }
}
