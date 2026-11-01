export class DeleteError extends Error {
    constructor(public status: number, public code: string) { super(code); }
}

export const validDeletionRequestId = (value: unknown): value is string => typeof value === 'string'
    && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);

export function addressClaims(claims: Record<string, unknown>): { address: string; addressId: number } {
    const { address, address_id: value } = claims;
    // Some existing authenticated issuers encode the database path parameter as a string.
    const addressId = typeof value === 'string' && /^[1-9]\d{0,15}$/.test(value) ? Number(value) : value;
    if (typeof address !== 'string' || !address || address.length > 320 || !Number.isSafeInteger(addressId)
        || (addressId as number) < 1) throw new DeleteError(403, 'mailbox_generation_required');
    return { address, addressId: addressId as number };
}

export function deletionErrorResponse(error: unknown, fallback = 'remote_delete_storage_unavailable'): Response {
    return Response.json({ error: { code: error instanceof DeleteError ? error.code : fallback } },
        { status: error instanceof DeleteError ? error.status : 503 });
}

export async function readDeletionRequest(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new DeleteError(415, 'json_required');
    if (Number(request.headers.get('content-length')) > 8192) throw new DeleteError(413, 'body_too_large');
    const reader = request.body?.getReader();
    if (!reader) throw new DeleteError(400, 'invalid_delete_request');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 8192) { await reader.cancel(); throw new DeleteError(413, 'body_too_large'); }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DeleteError(400, 'invalid_delete_request');
        return body as Record<string, unknown>;
    } catch (error) { if (error instanceof DeleteError) throw error; throw new DeleteError(400, 'invalid_delete_request'); }
    finally { reader.releaseLock(); }
}
