import { CONSTANTS } from './constants';

export interface CustomAddressEnv {
    DB: D1Database;
    ADMIN_PASSWORDS?: unknown;
    DOMAINS?: unknown;
    DEFAULT_DOMAINS?: unknown;
    ENABLE_USER_CREATE_EMAIL?: unknown;
    DISABLE_CUSTOM_ADDRESS_NAME?: unknown;
    MIN_ADDRESS_LEN?: unknown;
    MAX_ADDRESS_LEN?: unknown;
    ADDRESS_REGEX?: unknown;
    ADDRESS_CHECK_REGEX?: unknown;
}

export class CustomAddressError extends Error {
    constructor(readonly status: 400 | 401 | 403 | 413 | 415 | 503, readonly code: string) { super(code); }
}
const unavailable = () => new CustomAddressError(503, 'custom_address_policy_unavailable');
const enabled = (value: unknown) => value === true || value === 'true';
function booleanSetting(value: unknown): boolean {
    if (value != null && ![true, false, 'true', 'false', ''].includes(value as string | boolean)) throw unavailable();
    return enabled(value);
}

function stringArray(value: unknown): string[] {
    if (value == null || value === '') return [];
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (!Array.isArray(parsed) || parsed.length > 256 || parsed.some((item) => typeof item !== 'string')) throw unavailable();
    return parsed;
}

export function requireCustomAddressAdmin(request: Request, env: CustomAddressEnv): void {
    let keys: string[] = [];
    try { keys = stringArray(env.ADMIN_PASSWORDS); } catch { /* Malformed credentials must fail closed. */ }
    const provided = request.headers.get('x-admin-auth');
    if (!provided || !keys.filter((key) => key.length > 0).includes(provided)) throw new CustomAddressError(401, 'custom_address_admin_required');
}

function length(value: unknown, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) throw unavailable();
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) throw unavailable();
    return parsed;
}

function regex(value: unknown, fallback: string, flags = ''): RegExp {
    if (value != null && typeof value !== 'string') throw unavailable();
    return new RegExp(value || fallback, flags);
}

function domains(value: unknown): string[] {
    const list = stringArray(value).map((item) => item.trim().toLowerCase());
    if (list.some((item) => item.length > 253 || item.split('.').length < 2
        || !item.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw unavailable();
    return [...new Set(list)];
}

export async function customAddressPolicy(env: CustomAddressEnv) {
    try {
        const configured = domains(env.DOMAINS), defaults = domains(env.DEFAULT_DOMAINS);
        const allowed = (defaults.length ? defaults : configured).filter((domain) => configured.includes(domain));
        const minLength = length(env.MIN_ADDRESS_LEN, 1), maxLength = Math.min(length(env.MAX_ADDRESS_LEN, 30), 30);
        if (minLength > maxLength) throw unavailable();
        const clean = regex(env.ADDRESS_REGEX, '[^a-z0-9]', 'g'), check = regex(env.ADDRESS_CHECK_REGEX, '^[a-z0-9]+$');
        // Do not use getJsonSetting: its legacy error recovery would silently disable this protection.
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(CONSTANTS.ADDRESS_BLOCK_LIST_KEY).first<{ value: string }>();
        if (row && (typeof row.value !== 'string' || !row.value)) throw unavailable();
        const blocked = row ? stringArray(row.value) : [];
        if (blocked.some((item) => !item || item.length > 1024)) throw unavailable();
        const allowCreate = booleanSetting(env.ENABLE_USER_CREATE_EMAIL), denyCustom = booleanSetting(env.DISABLE_CUSTOM_ADDRESS_NAME);
        const active = allowCreate && !denyCustom && allowed.length > 0;
        return { capability: { contract: 'easyemail-custom-address-v1', enabled: active, minLength, maxLength, domains: allowed },
            validate(name: unknown, domain: unknown) {
                if (!active) throw new CustomAddressError(403, 'custom_address_disabled');
                if (typeof name !== 'string' || !/^[a-z0-9]{1,30}$/.test(name) || name.length < minLength || name.length > maxLength
                    || name.replace(clean, '') !== name || !check.test(name) || blocked.some((item) => name.includes(item))) {
                    throw new CustomAddressError(400, 'invalid_custom_address_name');
                }
                if (typeof domain !== 'string' || !allowed.includes(domain)) throw new CustomAddressError(400, 'custom_address_domain_unavailable');
                return { name, domain };
            } };
    } catch (error) { if (error instanceof CustomAddressError) throw error; throw unavailable(); }
}
