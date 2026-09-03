import { Context } from 'hono';

import { expandDomainTemplates, getDefaultDomains, getStringValue, getUserRoles } from './utils';

export const commonGetUserRole = async (
    c: Context<HonoCustomType>, user_id: number
): Promise<UserRole | undefined | null> => {
    const user_roles = getUserRoles(c);
    const role_text = await c.env.DB.prepare(
        `SELECT role_text FROM user_roles where user_id = ?`
    ).bind(user_id).first<string | undefined | null>("role_text");
    return role_text ? user_roles.find((r) => r.role === role_text) : null;
}

export const getAddressPrefix = async (c: Context<HonoCustomType>): Promise<string | undefined> => {
    const user = c.get("userPayload");
    if (!user) {
        return getStringValue(c.env.PREFIX).trim().toLowerCase();
    }
    const user_role = await commonGetUserRole(c, user.user_id);
    if (typeof user_role?.prefix === "string") {
        return user_role.prefix.trim().toLowerCase();
    }
    return getStringValue(c.env.PREFIX).trim().toLowerCase();
}

export const getAllowDomains = async (c: Context<HonoCustomType>): Promise<string[]> => {
    const user = c.get("userPayload");
    if (!user) {
        return getDefaultDomains(c);
    }
    const user_role = await commonGetUserRole(c, user.user_id);
    if (Array.isArray(user_role?.domains) && user_role.domains.length > 0) {
        return expandDomainTemplates(c, user_role.domains);
    }
    return getDefaultDomains(c);
}
