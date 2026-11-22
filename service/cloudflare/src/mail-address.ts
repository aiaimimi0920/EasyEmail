export function validDomain(value: string): boolean {
  return value.length <= 253 && value.split(".").length >= 2
    && value.split(".").every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part));
}

// Deliberately a single ASCII addr-spec subset, not a general RFC mailbox-list parser.
export function mailAddress(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 254) return null;
  const parts = value.split("@");
  if (parts.length !== 2 || !/^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}$/.test(parts[0])
    || parts[0].startsWith(".") || parts[0].endsWith(".") || parts[0].includes("..")
    || !validDomain(parts[1].toLowerCase())) return null;
  return `${parts[0]}@${parts[1].toLowerCase()}`;
}

export function replyAddress(sender: string): string | null {
  const bare = mailAddress(sender);
  if (bare) return bare;
  if (/[\r\n,;<>]/.test(sender.replace(/<[^<>]*>$/, ""))) return null;
  const match = /^[^<>\r\n]*<([^<>]+)>$/.exec(sender);
  return match ? mailAddress(match[1]) : null;
}

export function rfcMessageId(value: unknown): string | null {
  return typeof value === "string" && value.length <= 254
    && /^<[a-zA-Z0-9!#$%&'*+/=?^_`{|}~.-]+@[a-zA-Z0-9.-]+>$/.test(value) ? value : null;
}
