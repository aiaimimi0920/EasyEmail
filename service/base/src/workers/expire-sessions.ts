import { MailRegistry } from "../domain/registry.js";

export interface SessionExpiryRecord {
  sessionId: string;
  expiredAt: string;
}

export function expireMailboxSessions(registry: MailRegistry, now: Date = new Date()): SessionExpiryRecord[] {
  const records: SessionExpiryRecord[] = [];

  for (const session of registry.listSessions()) {
    if (session.status !== "open" || !session.expiresAt) {
      continue;
    }

    if (session.expiresAt > now.toISOString()) {
      continue;
    }

    registry.saveSession({
      ...session,
      status: "expired",
    });

    records.push({
      sessionId: session.id,
      expiredAt: now.toISOString(),
    });
  }

  return records;
}
