// Match the additive partial index in 0049. Empty staged intents still reserve a slot;
// empty successful receipts and fully acknowledged retired history reserve no content.
export const AGENT_LIVE_BATCH = `state<>'retired' AND (state='staged' OR item_count>0 OR storage_bytes>0)`;

// Bind account id, additional items and additional bytes. Request admission adds 1/1
// as a strict-below-limit preflight; staging rechecks the actual plan atomically.
// Agent retirement releases the whole batch only after every deletion is acknowledged.
export const AGENT_INBOX_CAPACITY = `EXISTS(SELECT 1 FROM (
  SELECT COUNT(*) batches,COALESCE(SUM(item_count),0) items,COALESCE(SUM(storage_bytes),0) bytes
  FROM agent_inbox_batches WHERE account_id=? AND (${AGENT_LIVE_BATCH})
) WHERE batches<1000 AND items+?<=1000 AND bytes+?<=134217728)`;
