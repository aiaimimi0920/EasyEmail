import { Context } from 'hono';
import { WorkerMailerOptions } from 'worker-mailer';

import { getBooleanValue, getDomains, getStringArray, getIntValue, getJsonSetting, getJsonObjectValue, getRandomSubdomainDomains } from './utils';
import { CONSTANTS } from './constants';
import { AddressCreationSettings } from './models';

export const DEFAULT_NAME_REGEX = /[^a-z0-9]/g;
const DEFAULT_RANDOM_SUBDOMAIN_LENGTH = 8;
export const MAX_RANDOM_SUBDOMAIN_ATTEMPTS = 5;
const MAX_DOMAIN_LENGTH = 253;
const DOMAIN_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export const normalizeDomainValue = (domain: string): string => {
    return domain.trim().toLowerCase();
}

const isValidDomainLabel = (label: string): boolean => {
    return DOMAIN_LABEL_RE.test(label);
}

const areValidDomainLabels = (labels: string[]): boolean => {
    return labels.length > 0 && labels.every((label) => isValidDomainLabel(label));
}

/**
 * Check if send mail is enabled for a specific domain
 */
export const isSendMailEnabled = (
    c: Context<HonoCustomType>,
    mailDomain: string
): boolean => {
    // Check resend token for domain or global
    const resendEnabled = c.env.RESEND_TOKEN || c.env[
        `RESEND_TOKEN_${mailDomain.replace(/\./g, "_").toUpperCase()}`
    ];
    if (resendEnabled) return true;

    // Check SMTP config for domain
    const smtpConfigMap = getJsonObjectValue<Record<string, WorkerMailerOptions>>(c.env.SMTP_CONFIG);
    if (smtpConfigMap && smtpConfigMap[mailDomain]) return true;

    // Check SEND_MAIL binding
    if (isSendMailBindingEnabled(c, mailDomain)) return true;

    return false;
}

export const isSendMailBindingEnabled = (
    c: Context<HonoCustomType>,
    mailDomain: string
): boolean => {
    if (!c.env.SEND_MAIL) {
        return false;
    }
    const sendMailDomains = getStringArray(c.env.SEND_MAIL_DOMAINS)
        .map((domain) => normalizeDomainValue(domain));
    if (sendMailDomains.length === 0) {
        return true;
    }
    const normalizedMailDomain = normalizeDomainValue(mailDomain);
    if (sendMailDomains.includes(normalizedMailDomain)) {
        return true;
    }
    return sendMailDomains.some((configuredDomain) => {
        return normalizedMailDomain.length > configuredDomain.length
            && normalizedMailDomain.endsWith(`.${configuredDomain}`);
    });
}

/**
 * Check if send mail is enabled for any configured domain
 */
export const isAnySendMailEnabled = (c: Context<HonoCustomType>): boolean => {
    const domains = getDomains(c);
    return domains.some(domain => isSendMailEnabled(c, domain));
}

export const generateRandomName = (c: Context<HonoCustomType>): string => {
    // name min length min 1
    const minLength = Math.max(
        getIntValue(c.env.MIN_ADDRESS_LEN, 1),
        1
    );
    // name max length min 1
    const maxLength = Math.max(
        getIntValue(c.env.MAX_ADDRESS_LEN, 30),
        1
    );

    // Build full name recursively until minimum length is reached
    const buildName = (currentName: string = ""): string => {
        return currentName.length >= minLength
            ? currentName
            : buildName(currentName + Math.random().toString(36).substring(2, 15));
    };

    const fullName = buildName();

    // Return truncated to max length
    return fullName.substring(0, Math.min(fullName.length, maxLength));
};

export const generateRandomSubdomain = (c: Context<HonoCustomType>): string => {
    const charset = "abcdefghijklmnopqrstuvwxyz0123456789";
    const length = Math.min(
        Math.max(getIntValue(c.env.RANDOM_SUBDOMAIN_LENGTH, DEFAULT_RANDOM_SUBDOMAIN_LENGTH), 1),
        63
    );
    let subdomain = "";
    for (let i = 0; i < length; i++) {
        subdomain += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return subdomain;
}

export const allowRandomSubdomainForDomain = (
    c: Context<HonoCustomType>,
    domain: string
): boolean => {
    const normalizedDomain = normalizeDomainValue(domain);
    return getRandomSubdomainDomains(c)
        .map((item) => normalizeDomainValue(item))
        .includes(normalizedDomain);
}

const isCreateAddressSubdomainMatchEnvConfigured = (c: Context<HonoCustomType>): boolean => {
    return c.env.ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH !== undefined
        && c.env.ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH !== null
        && c.env.ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH !== "";
}

export const getAddressCreationSettings = async (
    c: Context<HonoCustomType>
): Promise<AddressCreationSettings> => {
    const value = await getJsonSetting<AddressCreationSettings>(
        c, CONSTANTS.ADDRESS_CREATION_SETTINGS_KEY
    );
    return new AddressCreationSettings(value);
}

export const getAddressCreationSubdomainMatchStatus = async (
    c: Context<HonoCustomType>,
    existingSettings?: AddressCreationSettings
): Promise<{
    envConfigured: boolean,
    envEnabled: boolean,
    storedEnabled: boolean | undefined,
    effectiveEnabled: boolean,
}> => {
    const envConfigured = isCreateAddressSubdomainMatchEnvConfigured(c);
    const envEnabled = getBooleanValue(c.env.ENABLE_CREATE_ADDRESS_SUBDOMAIN_MATCH);
    const addressCreationSettings = existingSettings || await getAddressCreationSettings(c);
    const storedEnabled = addressCreationSettings.enableSubdomainMatch;

    // 业务约束：env=false 作为全局 kill switch，后台开关不能强行打开。
    const effectiveEnabled = envConfigured && !envEnabled
        ? false
        : typeof storedEnabled === "boolean"
            ? storedEnabled
            : envEnabled;

    return {
        envConfigured,
        envEnabled,
        storedEnabled,
        effectiveEnabled,
    };
}

export const findMatchedAllowedDomain = (
    domain: string,
    allowDomains: string[],
    enableSubdomainMatch: boolean,
): string | null => {
    const normalizedDomain = normalizeDomainValue(domain);
    if (normalizedDomain.length > MAX_DOMAIN_LENGTH) {
        return null;
    }
    const domainLabels = normalizedDomain.split('.');
    if (!areValidDomainLabels(domainLabels)) {
        return null;
    }
    const normalizedAllowDomains = allowDomains.map((allowDomain) => normalizeDomainValue(allowDomain));
    if (normalizedAllowDomains.includes(normalizedDomain)) {
        return normalizedDomain;
    }
    if (!enableSubdomainMatch) {
        return null;
    }
    const matchedDomain = [...normalizedAllowDomains]
        .sort((a, b) => b.length - a.length)
        .find((allowDomain) => {
            if (allowDomain.length > MAX_DOMAIN_LENGTH) {
                return false;
            }
            const allowDomainLabels = allowDomain.split('.');
            if (!areValidDomainLabels(allowDomainLabels)) {
                return false;
            }
            if (domainLabels.length <= allowDomainLabels.length) {
                return false;
            }
            const prefixLabels = domainLabels.slice(0, domainLabels.length - allowDomainLabels.length);
            if (!areValidDomainLabels(prefixLabels)) {
                return false;
            }
            return allowDomainLabels.every((label, index) => {
                return domainLabels[domainLabels.length - allowDomainLabels.length + index] === label;
            });
        });
    return matchedDomain || null;
}

export const resolveManagedSenderDomain = async (
    c: Context<HonoCustomType>,
    mailDomain: string | undefined | null,
): Promise<string | null> => {
    const normalizedDomain = typeof mailDomain === "string"
        ? normalizeDomainValue(mailDomain)
        : "";
    if (!normalizedDomain) {
        return null;
    }

    const configuredDomains = getDomains(c);
    if (configuredDomains.includes(normalizedDomain)) {
        return normalizedDomain;
    }

    const randomSubdomainMatch = findMatchedAllowedDomain(
        normalizedDomain,
        getRandomSubdomainDomains(c),
        true,
    );
    if (randomSubdomainMatch) {
        return randomSubdomainMatch;
    }

    const { effectiveEnabled: enableSubdomainMatch } = await getAddressCreationSubdomainMatchStatus(c);
    return findMatchedAllowedDomain(normalizedDomain, configuredDomains, enableSubdomainMatch);
}
