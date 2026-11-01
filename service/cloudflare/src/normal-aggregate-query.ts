import type { Env, Identity } from "./contracts";
import { inboxContentMatch } from "./inbox-content-match";
import type { inboxQuery } from "./inbox-query";
import { normalSearchJoin, normalSearchVisible, normalSearchSourceColumns, type NormalSearchContext } from "./normal-search-index";
import { normalFolderCondition, normalPlatformState, normalStateColumns, normalStateJoin, type NormalPlatformColumns } from "./normal-message-state";
import { normalTaxonomySelection } from "./normal-message-taxonomy";

export interface NormalAggregateRow extends NormalPlatformColumns {
  id: string; account_id: string; epoch_id: string; uid: number; sender: string; recipient: string; subject: string;
  received_at: number; observed_at: number; flags: string; display_name: string; email_address: string; sortTime: number;
  source_folder_id: string | null; source_folder_name: string | null;
}
export async function normalAggregateRows(env: Env, identity: Identity, contexts: NormalSearchContext[],
  filters: Awaited<ReturnType<typeof inboxQuery>>["filters"], limit: number, cursor: { time: number; id: string } | null) {
  const taxonomy = await normalTaxonomySelection(env, identity, filters);
  if (!contexts.length || filters.mailboxId || filters.providerId) return [];
  const match = inboxContentMatch(filters), conditions = [match.matches, normalFolderCondition(filters.folder, "m"), taxonomy.condition];
  const values: (string | number)[] = [...match.matchValues, ...taxonomy.values];
  for (const [column, value] of [["is_read", filters.isRead], ["starred", filters.starred]] as const) {
    if (value !== null) { conditions.push(`m.${column}=?`); values.push(Number(value)); }
  }
  if (cursor) { conditions.push("(m.received_at<? OR (m.received_at=? AND m.id<?))"); values.push(cursor.time, cursor.time, cursor.id); }
  return (await env.DB.prepare(`SELECT m.id,m.account_id,m.epoch_id,m.uid,m.received_at,m.observed_at,m.flags,m.display_name,
    m.email_address,m.sender,m.recipient,m.subject,m.is_read,m.starred,m.archived,m.trashed_at,m.source_folder_id,m.source_folder_name,m.received_at AS sortTime FROM (SELECT m.id,m.account_id,m.epoch_id,m.uid,
    m.received_at,m.observed_at,m.flags,a.display_name,a.email_address,p.sender,p.recipient,p.subject,p.text_body,p.html_body,${normalStateColumns}
    ,${normalSearchSourceColumns} FROM normal_inbox_messages m ${normalSearchJoin(contexts)} JOIN normal_inbox_search p ON p.message_id=m.id AND p.content_sha256=m.content_sha256
    ${normalStateJoin} WHERE ${normalSearchVisible}) m WHERE ${conditions.join(" AND ")} ORDER BY m.received_at DESC,m.id DESC LIMIT ?`)
    .bind(JSON.stringify(contexts), identity.userId, ...values, limit + 1).all<NormalAggregateRow>()).results;
}
export function normalAggregateView(row: NormalAggregateRow) {
  return { sourceKind: "normal" as const, id: row.id, accountId: row.account_id, epochId: row.epoch_id, uid: row.uid,
    ...(row.source_folder_id ? { serverFolderId: row.source_folder_id, serverFolderName: row.source_folder_name } : {}),
    sender: row.sender, recipient: row.recipient, subject: row.subject, receivedAt: row.received_at, observedAt: row.observed_at,
    remoteFlags: JSON.parse(row.flags) as string[], platformState: normalPlatformState(row), mailboxAddress: row.email_address, mailboxDisplayName: row.display_name };
}
