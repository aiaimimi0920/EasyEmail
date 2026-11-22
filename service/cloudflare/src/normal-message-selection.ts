import type { Env, Identity } from "./contracts";
import type { inboxQuery } from "./inbox-query";
import { inboxContentMatch } from "./inbox-content-match";
import { normalSearchJoin, normalSearchVisible, normalSearchSourceColumns, type NormalSearchContext } from "./normal-search-index";
import { normalFolderCondition, normalStateColumns, normalStateJoin } from "./normal-message-state";
import { normalTaxonomySelection } from "./normal-message-taxonomy";

export async function normalMessageSelection(env: Env, identity: Identity, contexts: NormalSearchContext[], filters: Awaited<ReturnType<typeof inboxQuery>>["filters"], name = "visible") {
  const taxonomy = await normalTaxonomySelection(env, identity, filters), match = inboxContentMatch(filters);
  const matches = [match.matches], matchValues: (string | number)[] = [...match.matchValues];
  for (const [column, value] of [["is_read", filters.isRead], ["starred", filters.starred]] as const) {
    if (value !== null) { matches.push(`m.${column}=?`); matchValues.push(Number(value)); }
  }
  return { visible: `${name} AS (SELECT * FROM (SELECT m.*,${normalSearchSourceColumns},a.display_name,a.email_address,p.sender,p.recipient,p.subject,p.text_body,p.html_body,${normalStateColumns}
    FROM normal_inbox_messages m ${normalSearchJoin(contexts)} JOIN normal_inbox_search p ON p.message_id=m.id AND p.content_sha256=m.content_sha256
    ${normalStateJoin} WHERE ${normalSearchVisible}) m WHERE ${normalFolderCondition(filters.folder, "m")} AND ${taxonomy.condition})`,
    values: [JSON.stringify(contexts), identity.userId, ...taxonomy.values], matches: matches.join(" AND "), matchValues, partition: ["account_id", "epoch_id"],
    summary: "m.id,m.account_id,m.epoch_id,m.uid,m.received_at,m.observed_at,m.flags,m.display_name,m.email_address,m.sender,m.recipient,m.subject,m.is_read,m.starred,m.archived,m.trashed_at,m.source_folder_id,m.source_folder_name" };
}
