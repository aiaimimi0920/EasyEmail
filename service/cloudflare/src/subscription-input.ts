import { HttpError } from "./http";
import { replyAddress } from "./mail-address";
import { tokenHash } from "./security";
import { unsubscribeMethods } from "./subscription-methods";
import type { SubscriptionHeaders, SubscriptionPlan } from "./subscription-model";

const fields = ["listId", "unsubscribe", "unsubscribePost", "precedence", "listPost", "listHelp", "feedbackId"] as const;
export function parseSubscriptionHeaders(value: unknown): SubscriptionHeaders | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(502, "provider_invalid_response");
  const row = value as Record<string, unknown>;
  if (row.version !== 1 || fields.some(key => typeof row[key] !== "string")
    || (row.limited !== undefined && typeof row.limited !== "boolean")) throw new HttpError(502, "provider_invalid_response");
  let limited = row.limited === true;
  const normalized = Object.fromEntries(fields.map(key => {
    const text = row[key] as string;
    if (text.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(text.replace(/\t/g, ""))) { limited = true; return [key, ""]; }
    return [key, text.trim()];
  })) as Omit<SubscriptionHeaders, "limited">;
  return { ...normalized, limited };
}

export async function subscriptionPlan(sender: string, headers?: SubscriptionHeaders): Promise<SubscriptionPlan | null> {
  if (!headers) return null;
  const marked = fields.filter(key => key !== "precedence").some(key => headers[key]) || /^(bulk|list)$/i.test(headers.precedence);
  const match = /^(.*?)<([A-Za-z0-9][A-Za-z0-9._+-]{0,253})>\s*$/u.exec(headers.listId);
  const valid = match && match[2].includes(".") && !match[2].endsWith(".") && !match[2].includes("..");
  const listId = valid ? match[2].toLowerCase() : "", address = replyAddress(sender)?.toLowerCase() ?? "";
  const { methods, limited } = unsubscribeMethods(headers.unsubscribe);
  const key = marked && (listId || address) ? await tokenHash(listId ? `list:${listId}` : `sender:${address}`) : null;
  return { key, listId, sender: key ? address : "", methods: key ? methods : [],
    name: key ? (valid ? match[1].trim().replace(/^"|"$/g, "") || listId : sender.trim()).normalize("NFC").slice(0, 160) : "",
    limited: headers.limited || limited || (!!headers.listId && !valid) };
}
