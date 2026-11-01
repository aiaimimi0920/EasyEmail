import { Context } from 'hono'

import { commonParseMail, handleMailListQuery, updateAddressUpdatedAt } from '../common'
import { resolveRawEmailRow } from '../gzip'
import { parsedAttachmentMetadata } from './parsed_attachment_metadata'
import { resourceMailQuery } from './mail_resource_schema'
import { getBooleanValue } from '../utils'
import type { RawMailRow } from '../models'
import { parsedThreadHeaders } from './parsed_thread_headers'
import { parsedListHeaders } from './parsed_list_headers'

const toParsedMailRow = async (row: Record<string, unknown>, deleteEnabled: boolean): Promise<Record<string, unknown>> => {
    const raw = typeof row.raw === 'string' ? row.raw : '';
    const parsed = raw ? await commonParseMail({ rawEmail: raw }) : undefined;
    const { raw: _raw, ...rest } = row;
    return {
        ...rest,
        sender: parsed?.sender?.trim() ?? '',
        subject: parsed?.subject ?? '',
        text: parsed?.text ?? '',
        html: parsed?.html ?? '',
        attachments: await parsedAttachmentMetadata(parsed?.attachments ?? []),
        thread_headers: parsedThreadHeaders(parsed?.headers),
        subscription_headers: parsedListHeaders(parsed?.headers),
        remote_delete_enabled: deleteEnabled && typeof row.resource_version === 'string' && /^[0-9a-f]{32}$/.test(row.resource_version),
    };
};

const listParsedMails = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload");
    if (!address) return c.json({ "error": "No address" }, 400);
    const { limit, offset } = c.req.query();
    if (Number.parseInt(offset) <= 0) updateAddressUpdatedAt(c, address);
    const listRes = await handleMailListQuery(c,
        `${await resourceMailQuery(c.env.DB)} WHERE r.address = ?`,
        `SELECT count(*) as count FROM raw_mails where address = ?`,
        [address], limit, offset
    );
    if (listRes.status !== 200) return listRes;
    const { results, count } = await listRes.json() as { results: Record<string, unknown>[], count: number };
    const parsed = await Promise.all(results.map((row) => toParsedMailRow(row, getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL))));
    return c.json({ results: parsed, count });
};

const getParsedMail = async (c: Context<HonoCustomType>) => {
    const { address } = c.get("jwtPayload");
    const { mail_id } = c.req.param();
    const row = await c.env.DB.prepare(
        `${await resourceMailQuery(c.env.DB)} WHERE r.id = ? AND r.address = ?`
    ).bind(mail_id, address).first<RawMailRow>();
    if (!row) return c.json(null);
    const resolved = await resolveRawEmailRow(row);
    return c.json(await toParsedMailRow(resolved as Record<string, unknown>, getBooleanValue(c.env.ENABLE_USER_DELETE_EMAIL)));
};

export default { listParsedMails, getParsedMail };
