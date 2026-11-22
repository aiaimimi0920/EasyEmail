import type { Env } from "./contracts";
import { agentBatchObjectKeys, retireAgentInbox, type AgentRetirementBatch } from "./agent-inbox-retirement";

const LIMIT = 20;
interface Deletion extends AgentRetirementBatch { object_key: string }
const query = `SELECT d.object_key,b.id,b.user_id,b.account_id,b.manifest,b.item_count,b.storage_bytes FROM agent_inbox_object_deletions d JOIN agent_inbox_batches b ON b.id=d.batch_id
  WHERE b.state IN ('retiring','retired') AND NOT EXISTS(SELECT 1 FROM agent_inbox_state s WHERE s.claim_token=b.id AND s.claim_lease_until>unixepoch())
  AND NOT EXISTS(SELECT 1 FROM agent_incoming_messages m WHERE m.purged_at IS NULL AND (m.raw_key=d.object_key OR m.content_key=d.object_key))
  AND NOT EXISTS(SELECT 1 FROM normal_inbox_messages m WHERE m.purged_at IS NULL AND (m.raw_key=d.object_key OR m.content_key=d.object_key))`;
async function cleanObject(env: Env, key: string) {
  const row = await env.DB.prepare(`${query} AND d.object_key=?`).bind(key).first<Deletion>();
  if (!row || !env.INBOX || !agentBatchObjectKeys(row)?.includes(key)) return false;
  try {
    await env.INBOX.delete(key);
    await env.DB.prepare("UPDATE agent_inbox_object_deletions SET cleaned_at=unixepoch() WHERE object_key=?").bind(key).run();
    return true;
  } catch { return false; }
}
export async function cleanupAgentInbox(env: Env) {
  if (!env.INBOX) return { available: false, retiring: 0, cleaned: 0, inventoryCleaned: 0 };
  const retiring = await retireAgentInbox(env);
  const pending = (await env.DB.prepare(`${query} AND d.cleaned_at IS NULL ORDER BY d.created_at,d.object_key LIMIT ${LIMIT}`).all<Deletion>()).results;
  let cleaned = 0, inventoryCleaned = 0;
  for (const row of pending) if (await cleanObject(env, row.object_key)) cleaned++;
  const cursor = await env.DB.prepare("SELECT cursor FROM agent_inbox_cleanup_state WHERE id=1").first<string | null>("cursor");
  const listing = await env.INBOX.list({ prefix: "agent-inbox/v1/", limit: LIMIT, ...(cursor ? { cursor } : {}) });
  // A late put after an acknowledged delete still has exact journal intent. Unknown keys are never deleted by age alone.
  for (const object of listing.objects) if (await cleanObject(env, object.key)) inventoryCleaned++;
  await env.DB.batch([
    env.DB.prepare("UPDATE agent_inbox_cleanup_state SET cursor=? WHERE id=1").bind(listing.truncated ? listing.cursor : null),
    env.DB.prepare(`UPDATE agent_inbox_batches SET state='retired' WHERE state='retiring'
      AND NOT EXISTS(SELECT 1 FROM agent_inbox_object_deletions d WHERE d.batch_id=agent_inbox_batches.id AND d.cleaned_at IS NULL)`),
  ]);
  return { available: true, retiring, cleaned, inventoryCleaned };
}
export async function maintainAgentInbox(env: Env) {
  try { return await cleanupAgentInbox(env); }
  catch { console.error(JSON.stringify({ code: "agent_inbox_cleanup_unconfirmed" })); return null; }
}
