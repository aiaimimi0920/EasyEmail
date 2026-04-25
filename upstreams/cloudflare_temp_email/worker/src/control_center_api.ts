import { Context, Hono } from 'hono'

import { getBooleanValue, getDomains } from './utils'

export const api = new Hono<HonoCustomType>()

async function readCount(c: Context<HonoCustomType>, query: string): Promise<number> {
    const row = await c.env.DB.prepare(query).first<{ count?: number }>() || {};
    const count = Number(row.count ?? 0);
    return Number.isFinite(count) ? count : 0;
}

api.get('/mail/catalog', async (c: Context<HonoCustomType>) => {
    const domains = getDomains(c);
    const hasAddressPassword = getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD);

    return c.json({
        catalog: {
            providerGroups: [
                {
                    key: 'self-hosted',
                    displayName: 'Self Hosted Mail Worker',
                    description: 'Cloudflare Temp Email worker managed by x-custom-auth.',
                },
            ],
            businessStrategies: [
                {
                    id: 'self-hosted-first',
                    displayName: 'Self Hosted First',
                    description: 'Use the current mail worker as the primary mailbox source.',
                },
            ],
            defaultStrategyModeId: 'self-hosted-first',
            defaultStrategyMode: {
                service: 'mail',
                modeId: 'self-hosted-first',
                providerSelections: ['self-hosted'],
                eligibleProviderGroups: ['self-hosted'],
                providerGroupOrder: ['self-hosted'],
                strategyProfileId: 'self-hosted-first',
                strategyKey: 'self-hosted-first',
                warnings: [],
                explain: [
                    '当前邮件服务仅提供 self-hosted 站点邮箱能力。',
                    '控制中心应将其视为单一自托管邮件源。',
                ],
            },
            supportsStrategyMode: false,
            capabilities: {
                addressPassword: hasAddressPassword,
                sendMail: Boolean(c.env.SEND_MAIL || c.env.RESEND_TOKEN || c.env.SMTP_CONFIG),
                webhook: getBooleanValue(c.env.ENABLE_WEBHOOK),
            },
            domains,
        },
    });
})

api.get('/mail/snapshot', async (c: Context<HonoCustomType>) => {
    const [mailCount, addressCount, activeAddressCount7days, activeAddressCount30days, sendMailCount, unknownMailCount] = await Promise.all([
        readCount(c, 'SELECT count(*) as count FROM raw_mails'),
        readCount(c, 'SELECT count(*) as count FROM address'),
        readCount(c, "SELECT count(*) as count FROM address where updated_at > datetime('now', '-7 day')"),
        readCount(c, "SELECT count(*) as count FROM address where updated_at > datetime('now', '-30 day')"),
        readCount(c, 'SELECT count(*) as count FROM sendbox'),
        readCount(c, 'SELECT count(*) as count FROM raw_mails where address NOT IN (select name from address)'),
    ]);

    const recentMailsResult = await c.env.DB.prepare(
        'SELECT id, address, created_at, source, message_id FROM raw_mails ORDER BY id DESC LIMIT 10'
    ).all();
    const recentMails = recentMailsResult.results ?? [];

    const recentAddressesResult = await c.env.DB.prepare(
        'SELECT id, name, created_at, updated_at, source_meta FROM address ORDER BY id DESC LIMIT 10'
    ).all();
    const recentAddresses = recentAddressesResult.results ?? [];

    return c.json({
        snapshot: {
            service: 'cloudflare-temp-email',
            generatedAt: new Date().toISOString(),
            summary: {
                mailCount,
                addressCount,
                activeAddressCount7days,
                activeAddressCount30days,
                sendMailCount,
                unknownMailCount,
            },
            health: {
                ok: true,
                authMode: 'x-custom-auth',
                domains: getDomains(c),
                enableAddressPassword: getBooleanValue(c.env.ENABLE_ADDRESS_PASSWORD),
                enableWebhook: getBooleanValue(c.env.ENABLE_WEBHOOK),
            },
            recentMails,
            recentAddresses,
        },
    });
})
