import { mailResourcesReady } from './mail_resource_schema';
import { addressClaims, DeleteError, deletionErrorResponse, readDeletionRequest, validDeletionRequestId } from './deletion_request';

interface DeleteInput { requestId: string; mailId: string; expectedVersion: string }
interface Owner { address: string; addressId: number }
interface Operation extends DeleteInput { state: 'deleted' | 'absent' | 'changed' }
const response = (operation: Operation) => Response.json({ operation: {
    requestId: operation.requestId, mailId: operation.mailId, expectedVersion: operation.expectedVersion, state: operation.state,
} });

async function owner(db: D1Database, claims: Record<string, unknown>): Promise<Owner> {
    const { address, addressId } = addressClaims(claims);
    const row = await db.prepare('SELECT id FROM address WHERE id=? AND name=?').bind(addressId, address).first();
    if (!row) throw new DeleteError(403, 'mailbox_generation_changed');
    return { address, addressId };
}

async function input(request: Request): Promise<DeleteInput> {
    const body = await readDeletionRequest(request);
    if (Object.keys(body).length !== 3 || !validDeletionRequestId(body.requestId)
        || typeof body.mailId !== 'string' || !/^[1-9]\d{0,15}$/.test(body.mailId) || !Number.isSafeInteger(Number(body.mailId))
        || typeof body.expectedVersion !== 'string' || !/^[0-9a-f]{32}$/.test(body.expectedVersion)) throw new DeleteError(400, 'invalid_delete_request');
    return body as unknown as DeleteInput;
}

function lookup(db: D1Database, account: Owner, requestId: string) {
    return db.prepare(`SELECT request_id AS requestId,mail_id AS mailId,expected_version AS expectedVersion,state
        FROM mail_delete_operations WHERE address_id=? AND address=? AND request_id=?`)
        .bind(account.addressId, account.address, requestId).first<Operation>();
}

export async function conditionalMailDelete(request: Request, db: D1Database, claims: Record<string, unknown>, enabled: boolean): Promise<Response> {
    try {
        const account = await owner(db, claims), body = await input(request);
        if (!await mailResourcesReady(db)) throw new DeleteError(503, 'mail_resource_schema_required');
        const previous = await lookup(db, account, body.requestId);
        if (previous) {
            if (previous.mailId !== body.mailId || previous.expectedVersion !== body.expectedVersion) throw new DeleteError(409, 'idempotency_conflict');
            return response(previous);
        }
        if (!enabled) throw new DeleteError(403, 'remote_delete_disabled');
        await db.batch([
            db.prepare(`INSERT INTO mail_delete_operations(address_id,request_id,address,mail_id,expected_version,state,created_at)
                SELECT ?,?,?,?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM raw_mails WHERE id=? AND address=?) THEN 'absent'
                    WHEN EXISTS(SELECT 1 FROM raw_mails r JOIN raw_mail_resources v ON v.mail_id=r.id
                        WHERE r.id=? AND r.address=? AND v.version=?) THEN 'deleted' ELSE 'changed' END,unixepoch()
                WHERE EXISTS(SELECT 1 FROM address WHERE id=? AND name=?)
                ON CONFLICT(address_id,request_id) DO NOTHING`)
                .bind(account.addressId, body.requestId, account.address, body.mailId, body.expectedVersion,
                    body.mailId, account.address, body.mailId, account.address, body.expectedVersion, account.addressId, account.address),
            db.prepare(`DELETE FROM raw_mails WHERE id=? AND address=?
                AND EXISTS(SELECT 1 FROM raw_mail_resources WHERE mail_id=raw_mails.id AND version=?)
                AND EXISTS(SELECT 1 FROM mail_delete_operations WHERE address_id=? AND address=? AND request_id=?
                    AND mail_id=? AND expected_version=? AND state='deleted')
                AND EXISTS(SELECT 1 FROM address WHERE id=? AND name=?)`)
                .bind(body.mailId, account.address, body.expectedVersion, account.addressId, account.address, body.requestId,
                    body.mailId, body.expectedVersion, account.addressId, account.address),
        ]);
        const saved = await lookup(db, account, body.requestId);
        if (!saved) throw new DeleteError(403, 'mailbox_generation_changed');
        if (saved.mailId !== body.mailId || saved.expectedVersion !== body.expectedVersion) throw new DeleteError(409, 'idempotency_conflict');
        return response(saved);
    } catch (error) { return deletionErrorResponse(error); }
}

export async function mailDeletionStatus(requestId: string, db: D1Database, claims: Record<string, unknown>): Promise<Response> {
    try {
        if (!validDeletionRequestId(requestId)) throw new DeleteError(400, 'invalid_delete_request');
        // A revoked address generation can still read only its own durable operation receipt.
        const account = addressClaims(claims);
        if (!await mailResourcesReady(db)) throw new DeleteError(503, 'mail_resource_schema_required');
        const saved = await lookup(db, account, requestId);
        if (!saved) throw new DeleteError(404, 'deletion_not_found');
        return response(saved);
    } catch (error) { return deletionErrorResponse(error); }
}
