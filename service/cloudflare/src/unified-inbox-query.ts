import { HttpError } from "./http";
import { inboxQuery } from "./inbox-query";
import { tokenHash } from "./security";
import type { NormalSearchContext } from "./normal-search-index";

export interface UnifiedCursor { time: number; id: string; sourceKind: "temporary" | "normal"; filter: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function unifiedCursor(row: Omit<UnifiedCursor, "filter">, filter: string) {
  return btoa(JSON.stringify({ ...row, filter })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
export function unifiedSourceParams(url: URL) {
  const params = url.searchParams, sources = params.get("sources") ?? "", accountId = params.get("accountId") ?? "";
  for (const key of ["sources", "accountId", "cursor"]) if (params.getAll(key).length > 1) throw new HttpError(400, "invalid_filter");
  if (!["all", "normal", "temporary"].includes(sources) || (accountId && (!uuid.test(accountId) || sources === "temporary"))) throw new HttpError(400, "invalid_filter");
  if (accountId && (params.has("providerId") || params.has("mailboxId"))) throw new HttpError(400, "invalid_filter");
  return { sources, accountId };
}
export async function unifiedQuery(url: URL, userId: string, contexts: NormalSearchContext[]) {
  const copy = new URL(url), params = copy.searchParams, { sources, accountId } = unifiedSourceParams(url), raw = params.get("cursor");
  params.delete("sources"); params.delete("accountId"); params.delete("cursor");
  const query = await inboxQuery(copy, userId), { filters } = query;
  if (sources === "normal" && (filters.mailboxId || filters.providerId)) throw new HttpError(400, "normal_filter_unavailable");
  const filter = await tokenHash(JSON.stringify(["unified-inbox-v1", query.fingerprint, sources, accountId, contexts]));
  let cursor: UnifiedCursor | null = null;
  if (raw !== null) {
    try {
      if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      cursor = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
      if (!cursor || Object.keys(cursor).sort().join(",") !== "filter,id,sourceKind,time" || cursor.filter !== filter
        || !Number.isSafeInteger(cursor.time) || !uuid.test(cursor.id) || !["normal", "temporary"].includes(cursor.sourceKind)) throw new Error();
    } catch { throw new HttpError(400, "invalid_cursor"); }
  }
  return { ...query, filter, cursor, sources, accountId };
}
export function sourceWindow(kind: UnifiedCursor["sourceKind"], cursor: UnifiedCursor | null) {
  return cursor ? { time: cursor.time, id: kind === cursor.sourceKind ? cursor.id : kind < cursor.sourceKind ? "~" : "" } : null;
}
