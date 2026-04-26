import { Hono } from 'hono'
import { Jwt } from 'hono/utils/jwt'

import utils, { checkCfTurnstile, getPasswords, getAdminPasswords, hashPassword } from '../utils';
import i18n from '../i18n';

const api = new Hono<HonoCustomType>()
const passwordHashCache = new Map<string, Promise<string>>();

const getCachedPasswordHash = (password: string): Promise<string> => {
    let cachedHash = passwordHashCache.get(password);
    if (!cachedHash) {
        cachedHash = hashPassword(password);
        passwordHashCache.set(password, cachedHash);
    }
    return cachedHash;
}

const getCachedPasswordHashSet = async (passwords: string[]): Promise<Set<string>> => {
    return new Set(await Promise.all(passwords.map((password) => getCachedPasswordHash(password))));
}

api.post('/open_api/site_login', async (c) => {
    const { password, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    const passwords = getPasswords(c);
    const hashedPasswords = await getCachedPasswordHashSet(passwords);
    if (!hashedPasswords.size || !password || !hashedPasswords.has(password)) {
        return c.text(msgs.CustomAuthPasswordMsg, 401)
    }
    return c.json({ success: true })
})

api.post('/open_api/admin_login', async (c) => {
    const { password, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    const adminPasswords = getAdminPasswords(c);
    const hashedPasswords = await getCachedPasswordHashSet(adminPasswords);
    if (!hashedPasswords.size || !password || !hashedPasswords.has(password)) {
        return c.text(msgs.NeedAdminPasswordMsg, 401)
    }
    return c.json({ success: true })
})

api.post('/open_api/credential_login', async (c) => {
    const { credential, cf_token } = await c.req.json();
    const msgs = i18n.getMessagesbyContext(c);
    if (utils.isGlobalTurnstileEnabled(c)) {
        try {
            await checkCfTurnstile(c, cf_token);
        } catch (error) {
            return c.text(msgs.TurnstileCheckFailedMsg, 400)
        }
    }
    if (!credential) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    try {
        const payload = await Jwt.verify(credential, c.env.JWT_SECRET, "HS256");
        if (!payload.address) {
            return c.text(msgs.InvalidAddressCredentialMsg, 401)
        }
    } catch (error) {
        return c.text(msgs.InvalidAddressCredentialMsg, 401)
    }
    return c.json({ success: true })
})

export { api }
