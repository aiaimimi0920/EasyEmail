import { addressClaims, DeleteError, deletionErrorResponse } from './deletion_request';

// Mounted only behind verified JWT authentication and the generation pre/post read fence.
export async function mailboxIdentity(db: D1Database, claims: Record<string, unknown>): Promise<Response> {
    try {
        const account = addressClaims(claims);
        const expiry = claims.exp;
        if (expiry !== undefined && (!Number.isSafeInteger(expiry) || (expiry as number) <= Math.floor(Date.now() / 1000))) {
            throw new DeleteError(401, 'mailbox_credential_expired');
        }
        const current = await db.prepare('SELECT id FROM address WHERE id=? AND name=?')
            .bind(account.addressId, account.address).first();
        if (!current) throw new DeleteError(403, 'mailbox_generation_changed');
        return Response.json({ contract: 'easyemail-mailbox-identity-v1', addressId: String(account.addressId),
            address: account.address, expiresAt: expiry ?? null }, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return deletionErrorResponse(error, 'mailbox_identity_storage_unavailable'); }
}
