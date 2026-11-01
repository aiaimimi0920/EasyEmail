import type { Context } from 'hono';
import { newAddress } from '../common-address';
import { CustomAddressError, customAddressPolicy, requireCustomAddressAdmin } from '../custom-address-policy';

function failure(error: unknown): Response {
    const known = error instanceof CustomAddressError;
    return Response.json({ error: { code: known ? error.code : 'custom_address_result_unknown' } },
        { status: known ? error.status : 503, headers: { 'cache-control': 'no-store' } });
}

async function input(request: Request): Promise<Record<string, unknown>> {
    if (request.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new CustomAddressError(415, 'custom_address_json_required');
    }
    if (Number(request.headers.get('content-length')) > 8192) throw new CustomAddressError(413, 'custom_address_request_too_large');
    const reader = request.body?.getReader();
    if (!reader) throw new CustomAddressError(400, 'invalid_custom_address_request');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
        while (true) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength;
            if (size > 8192) { await reader.cancel(); throw new CustomAddressError(413, 'custom_address_request_too_large'); }
            chunks.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        const row = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
        if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((key) => !['name', 'domain'].includes(key))) {
            throw new CustomAddressError(400, 'invalid_custom_address_request');
        }
        return row;
    } catch (error) { if (error instanceof CustomAddressError) throw error; throw new CustomAddressError(400, 'invalid_custom_address_request'); }
    finally { reader.releaseLock(); }
}

export async function customAddressCapability(c: Context<HonoCustomType>): Promise<Response> {
    try {
        requireCustomAddressAdmin(c.req.raw, c.env);
        const { capability } = await customAddressPolicy(c.env);
        return Response.json(capability, { headers: { 'cache-control': 'no-store' } });
    } catch (error) { return failure(error); }
}

export async function createCustomAddress(c: Context<HonoCustomType>): Promise<Response> {
    try {
        requireCustomAddressAdmin(c.req.raw, c.env);
        const row = await input(c.req.raw), policy = await customAddressPolicy(c.env);
        const { name, domain } = policy.validate(row.name, row.domain);
        // This trusted-service contract replaces the public anonymous/Turnstile gate, not name/domain policy.
        const result = await newAddress(c, { name, domain, enablePrefix: false, addressPrefix: null,
            enableRandomSubdomain: false, checkLengthByConfig: true, checkAllowDomains: true,
            enableCheckNameRegex: false, sourceMeta: 'easyemail-custom-v1' });
        if (result.address !== `${name}@${domain}`) throw new Error('Unexpected custom address result');
        return Response.json(result, { status: 201, headers: { 'cache-control': 'no-store' } });
    } catch (error) { return failure(error); }
}
