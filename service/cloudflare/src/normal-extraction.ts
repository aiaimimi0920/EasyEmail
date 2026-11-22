import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json } from "./http";
import { normalInboxContext, assertNormalInboxCurrent } from "./normal-inbox-access";
import { extractionFilter } from "./extraction-query";
import { extractionResults, type ExtractionRow } from "./extraction-results";
import { normalSearchContexts, ensureNormalSearch, normalSearchJoin, normalSearchVisible } from "./normal-search-index";
import { normalStateJoin } from "./normal-message-state";

export async function normalExtractions(request: Request, env: Env, identity: Identity, accountId: string) {
  const context = await normalInboxContext(env, identity, accountId), url = new URL(request.url);
  for (const key of url.searchParams.keys()) if (!["since", "sender", "subject", "recipient", "kind"].includes(key)
    || url.searchParams.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
  const filter = extractionFilter(Object.fromEntries(url.searchParams), context.account.email_address);
  const contexts = await normalSearchContexts(env, identity, accountId, "inbox"); await ensureNormalSearch(env, identity, contexts, accountId, "inbox");
  const rows = (await env.DB.prepare(`SELECT m.id,m.received_at,p.sender,p.recipient,p.subject,p.text_body,p.html_body
    FROM normal_inbox_messages m ${normalSearchJoin(contexts)} JOIN normal_inbox_search p ON p.message_id=m.id AND p.content_sha256=m.content_sha256
    ${normalStateJoin} WHERE ${normalSearchVisible} AND ns.trashed_at IS NULL AND m.received_at>=? AND m.received_at<=? ORDER BY m.received_at DESC,m.id DESC LIMIT 11`)
    .bind(JSON.stringify(contexts), identity.userId, filter.since, unixNow() + 60).all<ExtractionRow>()).results;
  const result = extractionResults(rows, filter, 10); await assertNormalInboxCurrent(env, identity, context);
  return json({ ...result, searchLimit: 10, sync: { cachedOnly: true, nextPage: null } });
}
