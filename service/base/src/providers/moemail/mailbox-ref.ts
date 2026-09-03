import type { MoemailMailboxCredentials } from "./types.js";
import { readString } from "./payload.js";

export function encodeMoemailMailboxRef(
  instanceId: string,
  mailbox: MoemailMailboxCredentials,
): string {
  return `moemail:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeMoemailMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): MoemailMailboxCredentials | undefined {
  const prefix = `moemail:${expectedInstanceId}:`;
  if (!mailboxRef.trim().startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(
      decodeURIComponent(mailboxRef.slice(prefix.length)),
    ) as Record<string, unknown>;
    const emailId = readString(payload.emailId);
    const email = readString(payload.email)?.toLowerCase();
    if (!emailId || !email || !email.includes("@")) {
      return undefined;
    }
    return {
      emailId,
      email,
      localPart: readString(payload.localPart),
      domain: readString(payload.domain),
      credentialSetId: readString(payload.credentialSetId),
      credentialItemId: readString(payload.credentialItemId),
    };
  } catch {
    return undefined;
  }
}
