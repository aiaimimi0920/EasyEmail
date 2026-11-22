import type { Env, Identity } from "./contracts";
import { messageThreadPlan } from "./message-thread-input";
import { threadWriteStatements } from "./message-thread-store";
import { HttpError } from "./http";

// A bounded derived-cache warmup, not a supplier sync or a user-visible mail mutation.
export async function indexCachedConversations(env: Env, identity: Identity) {
  const { results } = await env.DB.prepare(`SELECT id,mailbox_id,sender,subject,rfc_message_id FROM messages
    WHERE user_id=? AND purged_at IS NULL AND thread_version=0 ORDER BY id LIMIT 21`).bind(identity.userId)
    .all<{ id: string; mailbox_id: string; sender: string; subject: string; rfc_message_id: string | null }>();
  if (!results.length) return false;
  const batches = await Promise.all(results.slice(0, 20).map(async row => threadWriteStatements(env, identity.userId, row.mailbox_id,
    { where: "m.id=? AND m.user_id=? AND m.thread_version=0", values: [row.id, identity.userId] },
    await messageThreadPlan({ ...row, rfcMessageId: row.rfc_message_id }))));
  try { await env.DB.batch(batches.flat()); } catch { throw new HttpError(503, "conversation_index_failed"); }
  return results.length > 20;
}
