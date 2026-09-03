import { readStringLike } from "./metadata.js";
import type { M2uMailboxCredentials } from "./types.js";

export function encodeM2uMailboxRef(instanceId: string, mailbox: M2uMailboxCredentials): string {
  return `m2u:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeM2uMailboxRef(
  mailboxRef: string,
  expectedInstanceId: string,
): M2uMailboxCredentials | undefined {
  const normalizedRef = mailboxRef.trim();
  const normalizedInstanceId = expectedInstanceId.trim();
  if (!normalizedRef || !normalizedInstanceId) {
    return undefined;
  }

  const prefix = `m2u:${normalizedInstanceId}:`;
  if (!normalizedRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(normalizedRef.slice(prefix.length))) as Record<string, unknown>;
    const email = readStringLike(payload.email) ?? "";
    const token = readStringLike(payload.token) ?? "";
    const viewToken = readStringLike(payload.viewToken) ?? readStringLike(payload.view_token) ?? "";
    if (!email || !token || !viewToken || !email.includes("@")) {
      return undefined;
    }

    return {
      email: email.trim().toLowerCase(),
      token: token.trim(),
      viewToken: viewToken.trim(),
      mailboxId: readStringLike(payload.mailboxId ?? payload.mailbox_id ?? payload.id),
      expiresAt: readStringLike(payload.expiresAt ?? payload.expires_at),
    };
  } catch {
    return undefined;
  }
}
