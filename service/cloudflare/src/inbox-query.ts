import { HttpError } from "./http";
import { tokenHash } from "./security";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FIELDS = new Set(["q", "sender", "recipient", "mailboxId", "providerId", "folder", "isRead", "starred", "since", "until", "limit", "cursor", "labelId", "folderId"]);
interface Cursor { time: number; id: string; filter: string }

export function encodeInboxCursor(time: number, id: string, filter: string): string {
  return btoa(JSON.stringify({ time, id, filter })).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeCursor(raw: string, filter: string): Cursor | null {
  if (!raw) return null;
  try {
    if (raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const value = JSON.parse(atob(raw.replaceAll("-", "+").replaceAll("_", "/")));
    if (!value || Object.keys(value).sort().join(",") !== "filter,id,time"
      || !Number.isSafeInteger(value.time) || typeof value.id !== "string" || !UUID.test(value.id)
      || value.filter !== filter) throw new Error();
    return value;
  } catch { throw new HttpError(400, "invalid_cursor"); }
}

export async function inboxQuery(url: URL, userId: string) {
  const params = url.searchParams;
  for (const key of params.keys()) {
    if (!FIELDS.has(key) || params.getAll(key).length !== 1) throw new HttpError(400, "invalid_filter");
  }
  const text = (key: string, max: number) => {
    const value = params.get(key) ?? "";
    if (value.length > max) throw new HttpError(400, "invalid_filter");
    return value;
  };
  const boolean = (key: string) => {
    const value = params.get(key);
    if (value !== null && value !== "true" && value !== "false") throw new HttpError(400, "invalid_filter");
    return value === null ? null : value === "true";
  };
  const date = (key: string) => {
    const value = params.get(key);
    if (value !== null && (!/^\d{1,11}$/.test(value) || Number(value) < 1)) throw new HttpError(400, "invalid_filter");
    return value === null ? null : Number(value);
  };
  const filters = { q: text("q", 256), sender: text("sender", 320), recipient: text("recipient", 320),
    mailboxId: text("mailboxId", 36), providerId: text("providerId", 48), folder: params.get("folder") ?? "inbox",
    isRead: boolean("isRead"), starred: boolean("starred"), since: date("since"), until: date("until"),
    ...(params.has("labelId") ? { labelId: text("labelId", 36) } : {}), ...(params.has("folderId") ? { folderId: text("folderId", 36) } : {}) };
  if ((filters.mailboxId && !UUID.test(filters.mailboxId))
    || (filters.providerId && !/^[a-z][a-z0-9-]{0,47}$/.test(filters.providerId))
    || (filters.labelId !== undefined && !UUID.test(filters.labelId))
    || (filters.folderId !== undefined && !UUID.test(filters.folderId))
    || !["inbox", "archive", "all", "trash"].includes(filters.folder)
    || (filters.since !== null && filters.until !== null && filters.since > filters.until)) throw new HttpError(400, "invalid_filter");
  const rawLimit = params.get("limit") ?? "25";
  if (!/^\d{1,3}$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 100) throw new HttpError(400, "invalid_limit");
  // Binding prevents accidental reuse across users/filters; this is not a signed authorization token.
  const fingerprint = await tokenHash(JSON.stringify([userId, filters]));
  return { filters, limit: Number(rawLimit), fingerprint, cursor: decodeCursor(params.get("cursor") ?? "", fingerprint) };
}
