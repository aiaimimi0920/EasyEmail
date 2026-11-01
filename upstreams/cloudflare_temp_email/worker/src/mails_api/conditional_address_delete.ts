import { addressDeletionsReady } from './address_deletion_schema';
import { addressClaims, DeleteError, deletionErrorResponse, readDeletionRequest, validDeletionRequestId } from './deletion_request';

interface Account { address: string; addressId: number }
interface Operation { requestId: string; addressId: string; address: string; state: 'deleted' | 'absent' | 'changed' }
const result = (operation: Operation) => Response.json({ operation, cleanup: 'd1-mailbox-data-v1', externalResourcesDeleted: false });
const failure = (error: unknown) => deletionErrorResponse(error, 'address_delete_storage_unavailable');

async function ready(db: D1Database): Promise<void> {
    if (!await addressDeletionsReady(db)) throw new DeleteError(503, 'address_delete_schema_required');
}

function lookup(db: D1Database, account: Account, requestId: string) {
    return db.prepare(`SELECT request_id AS requestId,CAST(address_id AS TEXT) AS addressId,address,state
        FROM address_delete_operations WHERE address_id=? AND address=? AND request_id=?`)
        .bind(account.addressId, account.address, requestId).first<Operation>();
}

export async function addressDeletionCapability(db: D1Database, claims: Record<string, unknown>, enabled: boolean): Promise<Response> {
    try {
        const account = addressClaims(claims); await ready(db);
        if (!await db.prepare('SELECT id FROM address WHERE id=? AND name=?').bind(account.addressId, account.address).first()) {
            throw new DeleteError(403, 'mailbox_generation_changed');
        }
        return Response.json({ capability: { address: account.address, addressId: String(account.addressId), enabled,
            conditionalDelete: true, cleanup: 'd1-mailbox-data-v1', externalResourcesDeleted: false } });
    } catch (error) { return failure(error); }
}

export async function conditionalAddressDelete(request: Request, db: D1Database, claims: Record<string, unknown>, enabled: boolean): Promise<Response> {
    try {
        const account = addressClaims(claims), body = await readDeletionRequest(request);
        if (Object.keys(body).length !== 3 || !validDeletionRequestId(body.requestId) || typeof body.addressId !== 'string'
            || typeof body.address !== 'string') throw new DeleteError(400, 'invalid_delete_request');
        if (body.addressId !== String(account.addressId) || body.address !== account.address) throw new DeleteError(403, 'mailbox_generation_mismatch');
        await ready(db);
        const previous = await lookup(db, account, body.requestId);
        if (previous) return result(previous);
        if (!enabled) throw new DeleteError(403, 'remote_delete_disabled');
        // A private batch nonce prevents a losing concurrent request from doing cleanup on replay.
        const batchId = crypto.randomUUID();
        const guard = `EXISTS(SELECT 1 FROM address_delete_operations WHERE address_id=? AND address=? AND request_id=?
            AND batch_id=? AND state='deleted') AND EXISTS(SELECT 1 FROM address WHERE id=? AND name=?)`;
        const values = [account.addressId, account.address, body.requestId, batchId, account.addressId, account.address];
        const statements = [db.prepare(`INSERT INTO address_delete_operations(address_id,request_id,address,state,batch_id,created_at)
            VALUES(?,?,?,CASE WHEN EXISTS(SELECT 1 FROM address WHERE id=? AND name=?) THEN 'deleted'
                WHEN EXISTS(SELECT 1 FROM address WHERE id=? OR name=?) THEN 'changed' ELSE 'absent' END,?,unixepoch())
            ON CONFLICT(address_id,request_id) DO NOTHING`)
            .bind(account.addressId, body.requestId, account.address, account.addressId, account.address,
                account.addressId, account.address, batchId)];
        for (const table of ['raw_mails', 'address_sender', 'sendbox', 'auto_reply_mails']) {
            statements.push(db.prepare(`DELETE FROM ${table} WHERE address=? AND ${guard}`).bind(account.address, ...values));
        }
        statements.push(db.prepare(`DELETE FROM users_address WHERE address_id=? AND ${guard}`).bind(account.addressId, ...values));
        statements.push(db.prepare(`DELETE FROM address WHERE id=? AND name=? AND ${guard}`).bind(account.addressId, account.address, ...values));
        // Every database mutation, including the receipt, commits or rolls back together. No KV/S3 claim is made.
        await db.batch(statements);
        const saved = await lookup(db, account, body.requestId);
        if (!saved) throw new DeleteError(503, 'address_delete_storage_unavailable');
        return result(saved);
    } catch (error) { return failure(error); }
}

export async function addressDeletionStatus(requestId: string, db: D1Database, claims: Record<string, unknown>): Promise<Response> {
    try {
        if (!validDeletionRequestId(requestId)) throw new DeleteError(400, 'invalid_delete_request');
        const account = addressClaims(claims); await ready(db);
        // The authenticated old generation can read its receipt after deletion, but cannot adopt a replacement.
        const saved = await lookup(db, account, requestId);
        if (!saved) throw new DeleteError(404, 'address_deletion_not_found');
        return result(saved);
    } catch (error) { return failure(error); }
}
