import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import type { inboxQuery } from "./inbox-query";
import { requireTaxonomyFilters } from "./taxonomy-access";
import { inboxContentMatch } from "./inbox-content-match";

type Filters = Awaited<ReturnType<typeof inboxQuery>>["filters"];
export async function inboxSelection(env: Env, identity: Identity, filters: Filters) {
  await requireTaxonomyFilters(env, identity, filters);
  if (filters.mailboxId && !await env.DB.prepare("SELECT id FROM mailboxes WHERE id=? AND user_id=?").bind(filters.mailboxId, identity.userId).first()) throw new HttpError(404, "not_found");
  const location = ["m.user_id=?", "b.user_id=?", "m.purged_at IS NULL"], values: (string | number)[] = [identity.userId, identity.userId];
  const add = (sql: string, ...bindings: (string | number)[]) => { location.push(sql); values.push(...bindings); };
  add(filters.folder === "trash" ? "m.trashed_at IS NOT NULL" : "m.trashed_at IS NULL");
  if (["inbox", "archive"].includes(filters.folder)) add("m.archived=?", filters.folder === "archive" ? 1 : 0);
  if (filters.folderId) add("EXISTS (SELECT 1 FROM message_folders mf JOIN folders f ON f.user_id=mf.user_id AND f.id=mf.folder_id WHERE mf.user_id=m.user_id AND mf.message_id=m.id AND mf.folder_id=? AND f.deleted_at IS NULL)", filters.folderId);
  else if (filters.folder === "inbox") add("NOT EXISTS (SELECT 1 FROM message_folders mf WHERE mf.user_id=m.user_id AND mf.message_id=m.id)");
  if (filters.mailboxId) add("m.mailbox_id=?", filters.mailboxId);
  if (filters.labelId) add("EXISTS (SELECT 1 FROM message_labels ml JOIN labels l ON l.user_id=ml.user_id AND l.id=ml.label_id WHERE ml.user_id=m.user_id AND ml.message_id=m.id AND ml.label_id=? AND l.deleted_at IS NULL)", filters.labelId);
  if (filters.providerId) add("b.provider_id=?", filters.providerId);
  const content = inboxContentMatch(filters), matches: string[] = [content.matches], matchValues: (string | number)[] = [...content.matchValues];
  const match = (sql: string, ...bindings: (string | number)[]) => { matches.push(sql); matchValues.push(...bindings); };
  if (filters.isRead !== null) match("m.is_read=?", filters.isRead ? 1 : 0);
  if (filters.starred !== null) match("m.starred=?", filters.starred ? 1 : 0);
  return { location: location.join(" AND "), values, matches: matches.join(" AND ") || "1", matchValues };
}
