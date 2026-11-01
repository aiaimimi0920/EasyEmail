import { HttpError } from "../http";
import { MAIL_PAGE_SIZE } from "./contracts";
import { object, string } from "./http";
import { im215Id, im215Inbox } from "./im215-content";

const PREFIX = "im215-after-v1:";
export function im215Cursor(page: number, value?: string): string | undefined {
  if (page === 1) return undefined;
  if (!value?.startsWith(PREFIX) || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.slice(PREFIX.length))) throw new HttpError(409, "provider_cursor_unavailable");
  return value.slice(PREFIX.length);
}

export function im215Page(value: unknown, inboxId: string, after?: string) {
  const row = object(value), values = row.messages, total = row.total, unread = row.unreadCount, next = string(row.nextCursor, 128);
  if (!Array.isArray(values) || values.length > MAIL_PAGE_SIZE || !Number.isSafeInteger(total) || (total as number) < values.length
    || !Number.isSafeInteger(unread) || (unread as number) < 0 || (unread as number) > (total as number)
    || after === undefined && (total as number) > values.length && !next) throw new HttpError(502, "provider_invalid_response");
  const ids = new Set<string>(), rows = values.map(value => {
    const mail = object(value), id = im215Id(mail.id); im215Inbox(mail, inboxId);
    if (ids.has(id) || id === after) throw new HttpError(502, "provider_invalid_response");
    ids.add(id); return { id };
  });
  if (next && (im215Id(next) !== rows.at(-1)?.id || next === after || rows.length !== MAIL_PAGE_SIZE
    || after === undefined && total === rows.length)) throw new HttpError(502, "provider_invalid_response");
  return { rows, nextCursor: next ? `${PREFIX}${next}` : null };
}
