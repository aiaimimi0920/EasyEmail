import type { Env } from "./contracts";
import type { InboxItem } from "./normal-inbox-plan";
import type { AgentInboxClaim } from "./agent-inbox-claim";

function replyMatches(claim: AgentInboxClaim, item: InboxItem, followups: boolean) {
  const evidence = item.replyEvidence!, ids = evidence.candidates;
  const matches = followups ? `SELECT DISTINCT c.thread_id AS id,c.kind FROM agent_reply_candidates c
    WHERE c.user_id=? AND c.account_id=? AND c.service_id=(SELECT id FROM service)
    AND lower(c.rfc_message_id) IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})`
    : `SELECT DISTINCT t.id,'task' AS kind FROM agent_threads t JOIN agent_outgoing_messages o ON o.user_id=t.user_id AND o.thread_id=t.id
      WHERE t.user_id=? AND t.sender_account_id=? AND t.service_id=(SELECT id FROM service) AND o.submitted_at IS NOT NULL
      AND lower(o.rfc_message_id) IN (${ids.length ? ids.map(() => "?").join(",") : "NULL"})`;
  return { sql: `WITH service AS (SELECT id,status,trust_level FROM agent_services WHERE user_id=? AND email_address=? AND deleted_at IS NULL),
    matches AS (${matches})`, values: [claim.userId, evidence.from, claim.userId, claim.accountId, ...ids] };
}
// Header evidence is not sender authentication. Count typed roots, not matching Message-ID rows.
export function agentIncomingStatement(env: Env, claim: AgentInboxClaim, item: InboxItem, epochId: string, validity: string, followups = false) {
  const evidence = item.replyEvidence!, matches = replyMatches(claim, item, followups);
  const live = `EXISTS(SELECT 1 FROM agent_inbox_batches b JOIN agent_inbox_state s ON s.account_id=b.account_id
    WHERE b.id=? AND b.state='committed' AND s.version=b.from_version AND s.claim_token=b.id)`;
  return env.DB.prepare(`${matches.sql},
    decision AS (SELECT CASE WHEN ?=1 OR ? IS NULL THEN 'invalid_headers' WHEN NOT EXISTS(SELECT 1 FROM service) THEN 'unknown_service'
      WHEN EXISTS(SELECT 1 FROM service WHERE status<>'active' OR trust_level='blocked') THEN 'service_unavailable'
      WHEN (SELECT COUNT(*) FROM matches)>1 THEN 'ambiguous'
      WHEN (SELECT COUNT(*) FROM matches)=1 AND (SELECT kind FROM matches)='task' THEN 'linked' ELSE 'unmatched' END AS status)
    INSERT INTO agent_incoming_messages(id,user_id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,
      raw_bytes,content_bytes,received_at,observed_at,flags,summary,rfc_message_id,sender_address,association,service_id,thread_id)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,unixepoch(),?,?,?,?,decision.status,(SELECT id FROM service),
      CASE WHEN decision.status='linked' THEN (SELECT id FROM matches) ELSE NULL END FROM decision WHERE ${live}`)
    .bind(...matches.values, Number(evidence.limited), evidence.from,
      item.id, claim.userId, claim.accountId, claim.token, epochId, validity, item.uid, item.rawKey, item.contentKey, item.rawSha256, item.contentSha256,
      item.rawBytes, item.contentBytes, item.receivedAt, JSON.stringify(item.flags), JSON.stringify(item.summary), evidence.messageId, evidence.from, claim.token);
}

export function agentInboundReplyStatement(env: Env, claim: AgentInboxClaim, item: InboxItem) {
  const evidence = item.replyEvidence!, matches = replyMatches(claim, item, true);
  return env.DB.prepare(`${matches.sql}
    INSERT INTO agent_inbound_messages(user_id,thread_id,account_id,message_id,review_revision,created_at)
    SELECT m.user_id,(SELECT id FROM matches),m.account_id,m.id,COALESCE(r.revision,0),unixepoch()
    FROM agent_incoming_messages m JOIN agent_inbox_batches b ON b.id=m.batch_id
    JOIN agent_inbox_state s ON s.user_id=m.user_id AND s.account_id=m.account_id
    LEFT JOIN agent_incoming_reviews r ON r.user_id=m.user_id AND r.account_id=m.account_id AND r.message_id=m.id
    WHERE m.id=? AND m.batch_id=? AND b.state='committed' AND s.version=b.from_version AND s.claim_token=b.id
    AND m.association='unmatched' AND r.message_id IS NULL AND ?=0 AND ? IS NOT NULL
    AND EXISTS(SELECT 1 FROM service WHERE status='active' AND trust_level<>'blocked')
    AND (SELECT COUNT(*) FROM matches)=1 AND (SELECT kind FROM matches)='inbound'`)
    .bind(...matches.values, item.id, claim.token, Number(evidence.limited), evidence.from);
}
