import { normalizeAddress, readString } from "./payload.js";
import type { Mail2925MailboxRefPayload } from "./types.js";

export function encodeMail2925MailboxRef(instanceId: string, mailbox: Mail2925MailboxRefPayload): string {
  return `mail2925:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeMail2925MailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): Mail2925MailboxRefPayload | undefined {
  const prefix = `mail2925:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const aliasAddress = normalizeAddress(readString(payload.aliasAddress));
    const accountEmail = normalizeAddress(readString(payload.accountEmail));
    if (!aliasAddress || !accountEmail) {
      return undefined;
    }

    return {
      aliasAddress,
      accountEmail,
      folderName: readString(payload.folderName),
      credentialSetId: readString(payload.credentialSetId),
      credentialItemId: readString(payload.credentialItemId),
      createdAt: readString(payload.createdAt),
    };
  } catch {
    return undefined;
  }
}
