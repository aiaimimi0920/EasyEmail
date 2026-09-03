import { Context } from 'hono';
import { Jwt } from 'hono/utils/jwt';

import { getBooleanValue, getDomains, getIntValue, getJsonSetting, getStringValue, hashPassword } from './utils';
import { CONSTANTS } from './constants';
import i18n from './i18n';
import { getAllowDomains } from './common-access';
import {
    DEFAULT_NAME_REGEX,
    MAX_RANDOM_SUBDOMAIN_ATTEMPTS,
    allowRandomSubdomainForDomain,
    findMatchedAllowedDomain,
    generateRandomSubdomain,
    getAddressCreationSubdomainMatchStatus,
    normalizeDomainValue,
} from './common-domain';

const checkNameRegex = (c: Context<HonoCustomType>, name: string) => {
    let error = null;
    try {
        const regexStr = getStringValue(c.env.ADDRESS_CHECK_REGEX);
        if (!regexStr) return;
        const regex = new RegExp(regexStr);
        if (!regex.test(name)) {
            error = new Error(`Name not match regex: /${regexStr}/`);
        }
    }
    catch (e) {
        console.error("Failed to check address regex", e);
    }
    if (error) {
        throw error;
    }
}

const getNameRegex = (c: Context<HonoCustomType>): RegExp => {
    try {
        const regex = getStringValue(c.env.ADDRESS_REGEX);
        if (!regex) {
            return DEFAULT_NAME_REGEX;
        }
        return new RegExp(regex, 'g');
    }
    catch (e) {
        console.error("Failed to get address regex", e);
    }
    return DEFAULT_NAME_REGEX;
}

export function updateAddressUpdatedAt(
    c: Context<HonoCustomType>,
    address: string | undefined | null
): void {
    if (!address) {
        return;
    }
    // update address updated_at asynchronously
    c.executionCtx.waitUntil((async () => {
        try {
            await c.env.DB.prepare(
                `UPDATE address SET updated_at = datetime('now') where name = ?`
            ).bind(address).run();
        } catch (e) {
            console.warn("[updateAddressUpdatedAt] failed:", address, e);
        }
    })());
}

export const generateRandomPassword = (): string => {
    const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
    const randomBytes = new Uint8Array(16);
    crypto.getRandomValues(randomBytes);
    return Array.from(randomBytes, (value) => charset[value % charset.length]).join("");
}

const buildGeneratedPassword = async (
    c: Context<HonoCustomType>
): Promise<{ plainPassword: string; hashedPassword: string } | null> => {
    if (!getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD)) {
        return null;
    }

    const plainPassword = generateRandomPassword();
    const hashedPassword = await hashPassword(plainPassword);
    return { plainPassword, hashedPassword };
}

const insertAddressRecord = async (
    c: Context<HonoCustomType>,
    address: string,
    sourceMeta: string | undefined | null,
    msgs: ReturnType<typeof i18n.getMessagesbyContext>,
    generatedPassword?: { plainPassword: string; hashedPassword: string } | null,
): Promise<number | undefined> => {
    try {
        const result = generatedPassword
            ? await c.env.DB.prepare(
                `INSERT INTO address(name, password, source_meta) VALUES(?, ?, ?)`
            ).bind(address, generatedPassword.hashedPassword, sourceMeta).run()
            : await c.env.DB.prepare(
                `INSERT INTO address(name, source_meta) VALUES(?, ?)`
            ).bind(address, sourceMeta).run();
        if (!result.success) {
            throw new Error(msgs.FailedCreateAddressMsg)
        }
        return Number(result.meta?.last_row_id ?? 0) || undefined;
    } catch (e) {
        const message = (e as Error).message;
        // Fallback: source_meta field may not exist, try without it
        if (message && message.includes("source_meta")) {
            const result = generatedPassword
                ? await c.env.DB.prepare(
                    `INSERT INTO address(name, password) VALUES(?, ?)`
                ).bind(address, generatedPassword.hashedPassword).run()
                : await c.env.DB.prepare(
                    `INSERT INTO address(name) VALUES(?)`
                ).bind(address).run();
            if (!result.success) {
                throw new Error(msgs.FailedCreateAddressMsg)
            }
            return Number(result.meta?.last_row_id ?? 0) || undefined;
        }
        throw e;
    }
}

export const newAddress = async (
    c: Context<HonoCustomType>,
    {
        name,
        domain,
        enablePrefix,
        enableRandomSubdomain = false,
        checkLengthByConfig = true,
        addressPrefix = null,
        checkAllowDomains = true,
        enableCheckNameRegex = true,
        sourceMeta = null,
    }: {
        name: string, domain: string | undefined | null,
        enablePrefix: boolean,
        enableRandomSubdomain?: boolean,
        checkLengthByConfig?: boolean,
        addressPrefix?: string | undefined | null,
        checkAllowDomains?: boolean,
        enableCheckNameRegex?: boolean,
        sourceMeta?: string | undefined | null,
    }
): Promise<{ address: string, jwt: string, password?: string | null, address_id: number }> => {
    const msgs = i18n.getMessagesbyContext(c);
    // trim whitespace and remove special characters
    name = name.trim().replace(getNameRegex(c), '')
    // check name
    if (enableCheckNameRegex) {
        await checkNameBlockList(c, name);
        checkNameRegex(c, name);
    }
    // name min length min 1
    const minAddressLength = Math.max(
        checkLengthByConfig ? getIntValue(c.env.MIN_ADDRESS_LEN, 1) : 1,
        1
    );
    // name max length min 1
    const maxAddressLength = Math.max(
        checkLengthByConfig ? getIntValue(c.env.MAX_ADDRESS_LEN, 30) : 30,
        1
    );
    // check name length
    if (name.length < minAddressLength) {
        throw new Error(`${msgs.NameTooShortMsg} (min ${minAddressLength})`);
    }
    if (name.length > maxAddressLength) {
        throw new Error(`${msgs.NameTooLongMsg} (max ${maxAddressLength})`);
    }
    // create address with prefix
    if (typeof addressPrefix === "string") {
        name = addressPrefix.trim() + name;
    } else if (enablePrefix) {
        name = getStringValue(c.env.PREFIX).trim() + name;
    }
    // check domain
    const allowDomains = checkAllowDomains ? await getAllowDomains(c) : getDomains(c);
    // if domain is not set, select domain based on environment configuration
    if (!domain && allowDomains.length > 0) {
        const createAddressDefaultDomainFirst = getBooleanValue(c.env.CREATE_ADDRESS_DEFAULT_DOMAIN_FIRST);
        if (createAddressDefaultDomainFirst) {
            domain = normalizeDomainValue(allowDomains[0]);
        } else {
            domain = normalizeDomainValue(allowDomains[Math.floor(Math.random() * allowDomains.length)]);
        }
    } else if (typeof domain === "string") {
        domain = normalizeDomainValue(domain);
    }
    const { effectiveEnabled: enableSubdomainMatch } = await getAddressCreationSubdomainMatchStatus(c);
    const matchedAllowDomain = domain
        ? findMatchedAllowedDomain(domain, allowDomains, enableSubdomainMatch)
        : null;
    // check domain is valid
    if (!domain || !matchedAllowDomain) {
        throw new Error(msgs.InvalidDomainMsg)
    }
    if (enableRandomSubdomain && !allowRandomSubdomainForDomain(c, domain)) {
        throw new Error(msgs.RandomSubdomainNotAllowedMsg)
    }

    const generatedPassword = await buildGeneratedPassword(c);
    const maxAttempts = enableRandomSubdomain ? MAX_RANDOM_SUBDOMAIN_ATTEMPTS : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const addressDomain = enableRandomSubdomain
            ? `${generateRandomSubdomain(c)}.${domain}`
            : domain;
        const address = `${name}@${addressDomain}`;

        try {
            const insertedAddressId = await insertAddressRecord(
                c,
                address,
                sourceMeta,
                msgs,
                generatedPassword,
            );
            updateAddressUpdatedAt(c, address);

            const address_id = insertedAddressId ?? await c.env.DB.prepare(
                `SELECT id FROM address where name = ?`
            ).bind(address).first<number>("id");

            if (!address_id) {
                throw new Error(msgs.FailedCreateAddressMsg);
            }

            // create jwt
            const jwt = await Jwt.sign({
                address: address,
                address_id: address_id
            }, c.env.JWT_SECRET, "HS256")
            return {
                jwt: jwt,
                address: address,
                password: generatedPassword?.plainPassword ?? null,
                address_id: address_id,
            }
        } catch (e) {
            const message = (e as Error).message;
            if (message && message.includes("UNIQUE")) {
                if (enableRandomSubdomain && attempt < maxAttempts - 1) {
                    continue;
                }
                throw new Error(msgs.AddressAlreadyExistsMsg)
            }
            throw new Error(msgs.FailedCreateAddressMsg)
        }
    }

    throw new Error(msgs.FailedCreateAddressMsg)
}

const checkNameBlockList = async (
    c: Context<HonoCustomType>, name: string
): Promise<void> => {
    // check name block list
    const blockList = [] as string[];
    try {
        const value = await getJsonSetting(c, CONSTANTS.ADDRESS_BLOCK_LIST_KEY);
        blockList.push(...(value || []));
    } catch (error) {
        console.error(error);
    }
    if (blockList.some((item) => name.includes(item))) {
        throw new Error(`Name[${name}]is blocked`);
    }
}
