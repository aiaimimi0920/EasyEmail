-- Preserve all receipts, cursors, messages, reservations and object journals.
-- Only live reservations participate in the account's capacity aggregate.
CREATE INDEX agent_inbox_live_capacity
  ON agent_inbox_batches(account_id,item_count,storage_bytes)
  WHERE state<>'retired' AND (state='staged' OR item_count>0 OR storage_bytes>0);
