-- No receipt, identity, reservation, cursor or object journal is removed or rewritten.
CREATE INDEX normal_inbox_live_capacity
  ON normal_inbox_batches(account_id,item_count,released_items,storage_bytes,released_bytes)
  WHERE (status='staged' AND retired_at IS NULL) OR item_count>released_items OR storage_bytes>released_bytes;
CREATE INDEX normal_inbox_requests_recent ON normal_inbox_requests(account_id,created_at DESC,id DESC);
CREATE INDEX normal_inbox_object_ack_batch ON normal_inbox_object_deletions(batch_id,size_bytes) WHERE cleaned_at IS NOT NULL;
