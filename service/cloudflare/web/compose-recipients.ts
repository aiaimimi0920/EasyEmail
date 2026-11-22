export type RecipientTarget = "to" | "cc" | "bcc";
export interface RecipientEditor { to: string; cc?: string; bcc?: string }
export const addressList = (value = "") => value.trim() ? value.split(",").map(item => item.trim()) : [];
export const addressText = (value: string | string[]) => Array.isArray(value) ? value.join(", ") : value;
export function recipientFields(value: RecipientEditor) {
  const to = addressList(value.to);
  return { to: to.length > 1 ? to : to[0] ?? "", cc: addressList(value.cc), bcc: addressList(value.bcc) };
}
export const hasMultipleRecipients = (value: RecipientEditor) => addressList(value.to).length > 1
  || !!addressList(value.cc).length || !!addressList(value.bcc).length;
