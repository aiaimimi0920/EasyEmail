import { Context } from 'hono';

import { getBooleanValue } from './utils';
import { unbindTelegramByAddress } from './telegram_api/common';
import i18n from './i18n';

export const cleanup = async (
    c: Context<HonoCustomType>,
    cleanType: string | undefined | null,
    cleanDays: number | undefined | null
): Promise<boolean> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!cleanType || typeof cleanDays !== 'number' || cleanDays < 0 || cleanDays > 1000) {
        throw new Error(msgs.InvalidCleanupConfigMsg)
    }
    console.log(`Cleanup ${cleanType} before ${cleanDays} days`);
    switch (cleanType) {
        case "inactiveAddress":
            await batchDeleteAddressWithData(
                c,
                `updated_at < datetime('now', '-${cleanDays} day')`
            )
            break;
        case "addressCreated":
            await batchDeleteAddressWithData(
                c,
                `created_at < datetime('now', '-${cleanDays} day')`
            )
            break;
        case "unboundAddress":
            await batchDeleteAddressWithData(
                c,
                `id NOT IN (SELECT address_id FROM users_address) AND created_at < datetime('now', '-${cleanDays} day')`
            )
            break;
        case "mails": {
            while (true) {
                const result = await c.env.DB.prepare(`
                    DELETE FROM raw_mails
                    WHERE id IN (
                        SELECT id FROM raw_mails
                        WHERE created_at < datetime('now', '-${cleanDays} day')
                        LIMIT 1000
                    )`
                ).run();
                const changes = Number(result.meta?.changes ?? 0);
                if (!Number.isFinite(changes) || changes <= 0) {
                    break;
                }
            }
            break;
        }
        case "mails_unknow":
            await c.env.DB.prepare(`
                DELETE FROM raw_mails WHERE address NOT IN
                (select name from address) AND created_at < datetime('now', '-${cleanDays} day')`
            ).run();
            break;
        case "sendbox":
            await c.env.DB.prepare(`
                DELETE FROM sendbox WHERE created_at < datetime('now', '-${cleanDays} day')`
            ).run();
            break;
        case "emptyAddress":
            // Delete addresses that have no emails and were created more than N days ago
            await batchDeleteAddressWithData(
                c,
                `name NOT IN (SELECT DISTINCT address FROM raw_mails WHERE address IS NOT NULL) AND created_at < datetime('now', '-${cleanDays} day')`
            )
            break;
        default:
            throw new Error(msgs.InvalidCleanTypeMsg)
    }
    return true;
}

const batchDeleteAddressWithData = async (
    c: Context<HonoCustomType>,
    addressQueryCondition: string,
): Promise<boolean> => {
    await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address IN ( ` +
        `SELECT name FROM address WHERE ${addressQueryCondition})`
    ).run();
    await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address IN ( ` +
        `SELECT name FROM address WHERE ${addressQueryCondition})`
    ).run();
    await c.env.DB.prepare(
        `DELETE FROM auto_reply_mails WHERE address IN ( ` +
        `SELECT name FROM address WHERE ${addressQueryCondition})`
    ).run();
    await c.env.DB.prepare(
        `DELETE FROM address_sender WHERE address IN ( ` +
        `SELECT name FROM address WHERE ${addressQueryCondition})`
    ).run();
    await c.env.DB.prepare(
        `DELETE FROM users_address WHERE address_id IN ( ` +
        `SELECT id FROM address WHERE ${addressQueryCondition})`
    ).run();
    // delete address
    await c.env.DB.prepare(`
        DELETE FROM address WHERE ${addressQueryCondition}`
    ).run();
    return true;
}


export const deleteAddressWithData = async (
    c: Context<HonoCustomType>,
    address: string | undefined | null,
    address_id: number | undefined | null
): Promise<boolean> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        throw new Error(msgs.UserDeleteEmailDisabledMsg)
    }
    if (!address && !address_id) {
        throw new Error(msgs.RequiredFieldMsg)
    }
    // get address_id or address
    if (!address_id) {
        address_id = await c.env.DB.prepare(
            `SELECT id FROM address where name = ?`
        ).bind(address).first<number>("id");
    } else if (!address) {
        address = await c.env.DB.prepare(
            `SELECT name FROM address where id = ?`
        ).bind(address_id).first<string>("name");
    }
    // check address again
    if (!address || !address_id) {
        throw new Error(msgs.AddressNotFoundMsg);
    }
    // unbind telegram
    await unbindTelegramByAddress(c, address);
    // delete address and related data
    const { success: mailSuccess } = await c.env.DB.prepare(
        `DELETE FROM raw_mails WHERE address = ? `
    ).bind(address).run();
    const { success: sendAccess } = await c.env.DB.prepare(
        `DELETE FROM address_sender WHERE address = ? `
    ).bind(address).run();
    const { success: sendboxSuccess } = await c.env.DB.prepare(
        `DELETE FROM sendbox WHERE address = ? `
    ).bind(address).run();
    const { success: addressSuccess } = await c.env.DB.prepare(
        `DELETE FROM users_address WHERE address_id = ? `
    ).bind(address_id).run();
    const { success: autoReplySuccess } = await c.env.DB.prepare(
        `DELETE FROM auto_reply_mails WHERE address = ? `
    ).bind(address).run();
    const { success } = await c.env.DB.prepare(
        `DELETE FROM address WHERE name = ? `
    ).bind(address).run();
    if (!success || !mailSuccess || !sendboxSuccess || !addressSuccess || !sendAccess || !autoReplySuccess) {
        throw new Error(msgs.OperationFailedMsg)
    }
    return true;
}
