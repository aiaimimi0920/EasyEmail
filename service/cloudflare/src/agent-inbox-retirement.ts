import type { Env } from "./contracts";
import type { InboxManifest } from "./normal-inbox-plan";

export interface AgentRetirementBatch { id: string; user_id: string; account_id: string; manifest: string; item_count: number; storage_bytes: number }
export function agentBatchObjectKeys(batch: AgentRetirementBatch): string[] | null {
  try {
    const manifest = JSON.parse(batch.manifest) as InboxManifest;
    if (!Array.isArray(manifest.items) || manifest.items.length > 3 || manifest.items.length !== batch.item_count) return null;
    const prefix = `agent-inbox/v1/${batch.user_id}/${batch.account_id}/${batch.id}/`, keys: string[] = [];
    let bytes = 0;
    for (const item of manifest.items) {
      if (!Number.isInteger(item.uid) || item.uid < 1 || item.uid > 4294967295
        || item.rawKey !== `${prefix}${item.uid}.eml` || item.contentKey !== `${prefix}${item.uid}.json`
        || !Number.isInteger(item.rawBytes) || item.rawBytes < 1 || item.rawBytes > 2097152
        || !Number.isInteger(item.contentBytes) || item.contentBytes < 1 || item.contentBytes > 2097152) return null;
      bytes += item.rawBytes + item.contentBytes;
      keys.push(item.rawKey, item.contentKey);
    }
    return new Set(keys).size === keys.length && bytes === batch.storage_bytes ? keys : null;
  } catch { return null; }
}
const eligible = `NOT EXISTS(SELECT 1 FROM agent_inbox_state s WHERE s.account_id=b.account_id AND s.claim_token=b.id AND s.claim_lease_until>unixepoch())
  AND (b.state='staged' AND (b.created_at<=unixepoch()-90 OR EXISTS(SELECT 1 FROM agent_inbox_requests r WHERE r.id=b.request_id AND r.state='failed'))
    OR b.state='committed' AND (EXISTS(SELECT 1 FROM agent_accounts a WHERE a.id=b.account_id AND a.deleted_at IS NOT NULL)
      OR EXISTS(SELECT 1 FROM agent_inbox_state s WHERE s.account_id=b.account_id AND s.epoch_id IS NOT b.epoch_id)
      OR EXISTS(SELECT 1 FROM retention_policy p WHERE p.id=1 AND p.enabled=1 AND p.cache_days>0 AND b.committed_at<unixepoch()-p.cache_days*86400)))`;
export async function retireAgentInbox(env: Env) {
  const rows = (await env.DB.prepare(`SELECT b.id,b.user_id,b.account_id,b.manifest,b.item_count,b.storage_bytes FROM agent_inbox_batches b WHERE ${eligible} ORDER BY b.created_at,b.id LIMIT 10`)
    .all<AgentRetirementBatch>()).results;
  let retired = 0;
  for (const batch of rows) {
    const keys = agentBatchObjectKeys(batch); if (!keys) continue;
    const retiring = "EXISTS(SELECT 1 FROM agent_inbox_batches WHERE id=? AND state='retiring')";
    const writes = await env.DB.batch([
      env.DB.prepare(`UPDATE agent_inbox_batches AS b SET state='retiring' WHERE b.id=? AND ${eligible}`).bind(batch.id),
      env.DB.prepare(`UPDATE agent_incoming_messages SET purged_at=unixepoch() WHERE batch_id=? AND purged_at IS NULL AND ${retiring}`).bind(batch.id, batch.id),
      env.DB.prepare(`UPDATE agent_inbox_state SET cache_generation=cache_generation+1 WHERE account_id=? AND ${retiring}`).bind(batch.account_id, batch.id),
      env.DB.prepare(`UPDATE agent_inbox_requests SET state='failed',finished_at=unixepoch(),error_code='agent_inbox_interrupted'
        WHERE id=(SELECT request_id FROM agent_inbox_batches WHERE id=?) AND state='pending' AND ${retiring}`).bind(batch.id, batch.id),
      ...keys.map(key => env.DB.prepare(`INSERT INTO agent_inbox_object_deletions(object_key,batch_id,created_at)
        SELECT ?,?,unixepoch() WHERE ${retiring} ON CONFLICT(object_key) DO NOTHING`).bind(key, batch.id, batch.id)),
    ]);
    retired += writes[0].meta.changes;
  }
  return retired;
}
