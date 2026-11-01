import { addressClaims, DeleteError, deletionErrorResponse, validDeletionRequestId } from './mails_api/deletion_request';

function receiptAccess(request: Request): boolean {
    const path = new URL(request.url).pathname;
    // The conditional address handler decides changed/absent and replays the original receipt.
    if (request.method === 'POST' && path === '/api/address_deletions') return true;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;
    const match = /^\/api\/(?:address|mail)_deletions\/([^/]+)$/.exec(path);
    return !!match && validDeletionRequestId(match[1]);
}

async function denied(request: Request, db: D1Database, claims: Record<string, unknown>): Promise<Response | undefined> {
    try {
        const account = addressClaims(claims);
        if (receiptAccess(request)) return;
        const current = await db.prepare('SELECT id FROM address WHERE id=? AND name=?')
            .bind(account.addressId, account.address).first();
        if (!current) throw new DeleteError(403, 'mailbox_generation_changed');
    } catch (error) { return deletionErrorResponse(error, 'address_auth_storage_unavailable'); }
}

// Signature verification must run first. This guard catches only its own validation/storage failures.
export async function withAddressGeneration(
    request: Request, db: D1Database, claims: Record<string, unknown>, next: () => Promise<Response>
): Promise<Response> {
    const failure = await denied(request, db, claims);
    if (failure) return failure;
    const response = await next();
    // Do not return name-keyed read results if the generation changed while the handler was awaiting I/O.
    if (request.method === 'GET' || request.method === 'HEAD') return await denied(request, db, claims) ?? response;
    return response;
}
