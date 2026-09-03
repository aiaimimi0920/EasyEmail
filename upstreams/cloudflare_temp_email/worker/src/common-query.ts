import { Context } from 'hono';

import i18n from './i18n';

export const handleListQuery = async (
    c: Context<HonoCustomType>,
    query: string, countQuery: string, params: string[],
    limit: string | number | undefined | null,
    offset: string | number | undefined | null,
    /** Must be pre-validated (e.g. whitelist), NOT raw user input. Interpolated directly into SQL. */
    orderBy?: string
): Promise<Response> => {
    const msgs = i18n.getMessagesbyContext(c);
    if (typeof limit === "string") {
        limit = parseInt(limit);
    }
    if (typeof offset === "string") {
        offset = parseInt(offset);
    }
    if (!limit || limit < 0 || limit > 100) {
        return c.text(msgs.InvalidLimitMsg, 400)
    }
    if (offset == null || offset == undefined || offset < 0) {
        return c.text(msgs.InvalidOffsetMsg, 400)
    }
    const orderClause = orderBy || 'id desc';
    const resultsQuery = `${query} order by ${orderClause} limit ? offset ?`;
    const { results } = await c.env.DB.prepare(resultsQuery).bind(
        ...params, limit, offset
    ).all();
    const count = offset == 0 ? await c.env.DB.prepare(
        countQuery
    ).bind(...params).first("count") : 0;
    return c.json({ results, count });
}

/**
 * handleListQuery variant for raw_mails: resolves raw_blob → raw after query.
 */
export const handleMailListQuery = async (
    c: Context<HonoCustomType>,
    query: string, countQuery: string, params: string[],
    limit: string | number | undefined | null,
    offset: string | number | undefined | null,
    orderBy?: string
): Promise<Response> => {
    const { resolveRawEmailList } = await import('./gzip');
    const msgs = i18n.getMessagesbyContext(c);
    if (typeof limit === "string") limit = parseInt(limit);
    if (typeof offset === "string") offset = parseInt(offset);
    if (!limit || limit < 0 || limit > 100) return c.text(msgs.InvalidLimitMsg, 400);
    if (offset == null || offset == undefined || offset < 0) return c.text(msgs.InvalidOffsetMsg, 400);
    const orderClause = orderBy || 'id desc';
    const resultsQuery = `${query} order by ${orderClause} limit ? offset ?`;
    const { results } = await c.env.DB.prepare(resultsQuery).bind(
        ...params, limit, offset
    ).all();
    const resolvedResults = await resolveRawEmailList(results);
    const count = offset == 0 ? await c.env.DB.prepare(
        countQuery
    ).bind(...params).first("count") : 0;
    return c.json({ results: resolvedResults, count });
}
