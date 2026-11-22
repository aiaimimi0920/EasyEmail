# Version-conditional mail deletion

This API prevents a cached integer mail ID from deleting a newer resource after ID reuse.
It does not delete mailbox addresses. Clients must not fall back to legacy `DELETE /api/mails/:id`.

## Migration and authentication

DB v0.0.8 expands the schema through the admin DB migration's atomic D1 batch.
Fresh `db/schema.sql` includes the resource table, operation records and generation triggers.
Repeated migration preserves generations in a healthy schema. Repairing missing triggers/operation tables invalidates
existing resource generations but retains historical operation outcomes. The dated SQL file is the equivalent source;
repair must execute the whole group as an atomic batch, not individual statements against a live database.
Executors without that guarantee require full read/write isolation and separate verification. Never discard guards and replay writes.
Missing or drifted tables/triggers disable conditional deletion; parsed reads retain the legacy format.

Use the existing `/api/*` `Authorization: Bearer <Address JWT>` and optional `x-custom-auth` site password.
JWT claims must contain the current `address` and positive integer `address_id`.
Recreating an address does not authorize the old address generation to act on the new one.
`ENABLE_USER_DELETE_EMAIL` controls new writes; existing outcomes remain replayable/readable when disabled.

## Request

The parsed API reads content and `resource_version` (32 lowercase hex characters) in one SQL snapshot,
and exposes `remote_delete_enabled`. Never assign a newly observed generation to an old cached body match.

```http
POST /api/mail_deletions
Content-Type: application/json

{"requestId":"00000000-0000-4000-8000-000000000001","mailId":"1","expectedVersion":"0123456789abcdef0123456789abcdef"}
```

The actual body is limited to 8 KiB and exactly these three fields. mailId is a positive decimal safe-integer string.
The same requestId and body replay the durable outcome; a different body returns 409.
Triggers maintain generations across insertion, updates, deletion and ID reuse, including identical content.
The conditional decision, operation guard and deletion commit in one D1 batch and roll back together on failure.

HTTP 200 returns `operation: {requestId, mailId, expectedVersion, state}`:

- `deleted`: that generation matched and was deleted, not any future mail reusing the ID.
- `absent`: the ID is absent for this address; this does not prove this request deleted it.
- `changed`: the ID belongs to another generation; the newer version was not deleted.

```http
GET /api/mail_deletions/00000000-0000-4000-8000-000000000001
```

GET only reads the original operation for the current address generation. It does not create, cancel or retry deletion.
After address deletion the original JWT may still read its own mail receipt. A same-name replacement cannot read old receipts; this exception cannot read mail or submit a new mail deletion.
404 does not prove an in-flight POST can never arrive. Preserve unknown after timeouts or lost responses;
explicitly reconcile the original requestId with GET, without automatic writes using another key.
Operation guards outlive source messages. Rolling back code or a database snapshot does not undo an external deletion.
Local contract tests do not constitute production schema, complete JWT middleware or real-mail deletion acceptance.
