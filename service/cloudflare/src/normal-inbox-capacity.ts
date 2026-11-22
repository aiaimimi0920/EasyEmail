// Keep this predicate aligned with the additive live-capacity partial index (0037).
// Retired reservations with unacknowledged bytes still count; historical empty receipts do not.
export const NORMAL_LIVE_BATCH = `(status='staged' AND retired_at IS NULL)
  OR item_count>released_items OR storage_bytes>released_bytes`;

// One indexed aggregate, checked atomically by both request and staging INSERTs.
// Bind account id, additional items and additional bytes. Request admission reserves
// no content: its 1/1 preflight preserves the existing strictly-below-limit rule.
export const NORMAL_INBOX_CAPACITY = `EXISTS (SELECT 1 FROM (
  SELECT COUNT(*) AS batches,COALESCE(SUM(item_count-released_items),0) AS items,
    COALESCE(SUM(storage_bytes-released_bytes),0) AS bytes
  FROM normal_inbox_batches WHERE account_id=? AND (${NORMAL_LIVE_BATCH})
) WHERE batches<1000 AND items+?<=1000 AND bytes+?<=134217728)`;
