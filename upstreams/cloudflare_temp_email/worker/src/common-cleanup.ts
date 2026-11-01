import { Context } from 'hono';

import { getBooleanValue } from './utils';
import { unbindTelegramByAddress } from './telegram_api/common';
import i18n from './i18n';
import { addressClaims } from './mails_api/deletion_request';

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
                `updated_at < ?`, cleanDays
            )
            break;
        case "addressCreated":
            await batchDeleteAddressWithData(
                c,
                `created_at < ?`, cleanDays
            )
            break;
        case "unboundAddress":
            await batchDeleteAddressWithData(
                c,
                `id NOT IN (SELECT address_id FROM users_address) AND created_at < ?`, cleanDays
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
                `name NOT IN (SELECT DISTINCT address FROM raw_mails WHERE address IS NOT NULL) AND created_at < ?`, cleanDays
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
    cleanDays: number,
): Promise<boolean> => {
    const cutoff = await c.env.DB.prepare("SELECT datetime('now', ?) AS cutoff")
        .bind(`-${cleanDays} day`).first<string>('cutoff');
    if (!cutoff) throw new Error(i18n.getMessagesbyContext(c).InvalidCleanupConfigMsg);
    // One cutoff keeps this internal selection stable even when the atomic batch crosses a second.
    const statements = ['raw_mails', 'sendbox', 'auto_reply_mails', 'address_sender'].map((table) =>
        c.env.DB.prepare(`DELETE FROM ${table} WHERE address IN (SELECT name FROM address WHERE ${addressQueryCondition})`).bind(cutoff));
    statements.push(c.env.DB.prepare(`DELETE FROM users_address WHERE address_id IN (SELECT id FROM address WHERE ${addressQueryCondition})`).bind(cutoff));
    statements.push(c.env.DB.prepare(`DELETE FROM address WHERE ${addressQueryCondition}`).bind(cutoff));
    const results = await c.env.DB.batch(statements);
    if (results.some((result) => !result.success)) throw new Error(i18n.getMessagesbyContext(c).OperationFailedMsg);
    return true;
}


export const deleteAddressWithData = async (
    c: Context<HonoCustomType>,
    address: string | undefined | null,
    address_id: number | string | undefined | null
): Promise<boolean> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (!getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)) {
        throw new Error(msgs.UserDeleteEmailDisabledMsg)
    }
    if (!address && !address_id) {
        throw new Error(msgs.RequiredFieldMsg)
    }
    // get address_id or address
    if (address_id === undefined || address_id === null) {
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
    const account = addressClaims({ address, address_id });
    if (!await c.env.DB.prepare('SELECT id FROM address WHERE id=? AND name=?')
        .bind(account.addressId, account.address).first()) throw new Error(msgs.AddressNotFoundMsg);
    // unbind telegram
    await unbindTelegramByAddress(c, address);
    // KV cannot participate in this transaction. Every D1 mutation is fenced by the resolved generation.
    const guard = 'EXISTS(SELECT 1 FROM address WHERE id=? AND name=?)';
    const values = [account.addressId, account.address];
    const statements = ['raw_mails', 'address_sender', 'sendbox', 'auto_reply_mails'].map((table) =>
        c.env.DB.prepare(`DELETE FROM ${table} WHERE address=? AND ${guard}`).bind(account.address, ...values));
    statements.push(c.env.DB.prepare(`DELETE FROM users_address WHERE address_id=? AND ${guard}`).bind(account.addressId, ...values));
    statements.push(c.env.DB.prepare('DELETE FROM address WHERE id=? AND name=?').bind(...values));
    try {
        const results = await c.env.DB.batch(statements);
        if (results.some((result) => !result.success) || Number(results.at(-1)?.meta?.changes) !== 1) {
            throw new Error(msgs.OperationFailedMsg);
        }
    } catch {
        throw new Error(msgs.OperationFailedMsg);
    }
    return true;
}
