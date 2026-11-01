# Conditional address deletion API

This contract is available from DB v0.0.9 and does not replace `DELETE /api/delete_address`.
It is intended for controlled clients. The legacy endpoint also checks generations and batches D1 cleanup, but has no durable receipt or idempotency contract.

Use `Authorization: Bearer <Address JWT>` and `x-custom-auth` when the deployment requires a site password.
The JWT must contain both address and address_id, as a safe integer or a canonical positive decimal string.
All endpoints require the exact operation table definition and an AUTOINCREMENT address ID. Missing or drifted schema returns 503.

## Capability and generation

`GET /api/address_deletion_capability` checks the current ID/name pair and returns:

```json
{"capability":{"address":"test@example.test","addressId":"123","enabled":true,"conditionalDelete":true,"cleanup":"d1-mailbox-data-v1","externalResourcesDeleted":false}}
```

A missing or transferred generation returns 403 and never returns replacement credentials.

## Atomic deletion

```http
POST /api/address_deletions
Content-Type: application/json
```

```json
{"requestId":"12b09846-a5c0-4bb8-b6f8-0ef93279a238","addressId":"123","address":"test@example.test"}
```

Exactly these three fields are accepted; the actual request stream is limited to 8 KiB.
addressId/address must match the authenticated JWT. ENABLE_USER_DELETE_EMAIL gates new writes.
Disabling writes returns 403 for new requests but does not prevent replay or receipt lookup.
Decision, receipt and D1 cleanup commit in one batch. Failures roll back all changes; concurrent duplicate keys perform one cleanup batch.

HTTP 200 includes operation (requestId/addressId/address/state), cleanup, and externalResourcesDeleted=false.
deleted means the matching address generation and its raw_mails/address_sender/sendbox/auto_reply_mails/users_address were removed.
changed means the generation changed and no cleanup occurred. absent means it was already missing, not that this request deleted it.

## Lookup and retention

`GET /api/address_deletions/:requestId` only reads a receipt and never repeats deletion. An unobserved receipt returns 404.
A 404 does not prove an in-flight original request cannot arrive later; clients must not automatically change keys or retry deletion.
The original generation JWT can read its own receipt after deletion. Receipts are retained; replay cannot delete a same-name replacement.

Only the listed D1 data is covered. Telegram/Webhook KV and S3 objects are not deleted, and complete privacy erasure is not claimed.
After signature verification, `/api/*` checks the current ID/name pair and rechecks before returning reads; stale generations return 403 and D1 auth failures return 503.
Only the exact conditional-address POST and valid-UUID address/mail receipt GET/HEAD routes permit old generations to reconcile their own operations.
Legacy cleanup preserves ID-only/name-only callers, validates the full pair, batches D1 deletes and checks the address row count. Replacement during unbinding cannot clean up the new generation.
This cannot cancel already-dispatched writes and does not cover separate admin/user/Telegram entry points or existing signed external URLs. Aggregator Web deletion is not enabled yet.
Database restore, manual ID reuse and restored requests require separate reconciliation; reverting code does not undo deletion.
