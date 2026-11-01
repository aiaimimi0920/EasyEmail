import { rfcMessageId, replyAddress } from "./mail-address";
import { tokenHash } from "./security";
import { HttpError } from "./http";
import type { ThreadHeaders, ThreadPlan } from "./message-thread-model";
const canonical = (id: string) => id.replace(/@([^>]*)>$/, (_, domain: string) => `@${domain.toLowerCase()}>`);
function ids(value: string) {
  if (value.length > 8192 || /[\r\n\p{Cc}\p{Cf}]/u.test(value.replace(/\t/g, ""))) return { values: [], limited: true };
  const found = value.match(/<[^<>\s]+>/g) ?? [], remainder = value.replace(/<[^<>\s]+>/g, "").trim();
  if (remainder || found.some(id => !rfcMessageId(id))) return { values: [], limited: true };
  return { values: found.map(canonical), limited: false };
}
export function parseThreadHeaders(value: unknown): ThreadHeaders | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(502, "provider_invalid_response");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || typeof row.inReplyTo !== "string" || typeof row.references !== "string"
    || (row.limited !== undefined && typeof row.limited !== "boolean")) throw new HttpError(502, "provider_invalid_response");
  const parent = ids(row.inReplyTo), refs = ids(row.references);
  return { inReplyTo: parent.values.slice(-4), references: refs.values.length > 27 ? [...refs.values.slice(0, 13), ...refs.values.slice(-14)] : refs.values,
    limited: row.limited === true || parent.limited || refs.limited || parent.values.length > 4 || refs.values.length > 27 };
}
export function conversationSubject(subject: string) {
  let value = subject.trim().toLowerCase();
  for (let i = 0; i < 8; i++) {
    const next = value.replace(/^\s*(re|fw|fwd|回复|答复|转发)\s*[:：]\s*/i, "")
      .replace(/^\s*\[[^\]]*(re|fw|fwd|回复|答复|转发)[^\]]*\]\s*/i, "").trim();
    if (next === value) break;
    value = next;
  }
  return value;
}
export async function messageThreadPlan(mail: { sender: string; subject: string; rfcMessageId?: string | null; threadHeaders?: ThreadHeaders }): Promise<ThreadPlan> {
  const own = rfcMessageId(mail.rfcMessageId), headers = mail.threadHeaders;
  const raw = [...new Set([...(own ? [canonical(own)] : []), ...(headers?.references ?? []), ...(headers?.inReplyTo ?? [])])];
  const subject = conversationSubject(mail.subject), sender = replyAddress(mail.sender)?.toLowerCase();
  return { tokens: await Promise.all(raw.map(id => tokenHash(`rfc:${id}`))), version: headers ? 2 : 1, limited: headers?.limited ?? false,
    fallback: !raw.length && subject && sender ? await tokenHash(JSON.stringify([subject, sender])) : null };
}
