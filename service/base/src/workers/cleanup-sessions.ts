import { MailRegistry } from "../domain/registry.js";

export interface SessionCleanupOptions {
  keepRecentCount?: number;
}

export interface SessionCleanupRecord {
  sessionId: string;
  removedMessageIds: string[];
}

export function cleanupMailboxSessions(
  registry: MailRegistry,
  options: SessionCleanupOptions = {},
): SessionCleanupRecord[] {
  const keepRecentCount = Math.max(0, options.keepRecentCount ?? 5000);
  const closedSessions = registry
    .listSessions()
    .filter((session) => session.status !== "open")
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  const removableSessions = closedSessions.slice(keepRecentCount);
  if (removableSessions.length === 0) {
    return [];
  }

  const messageIdsBySession = new Map<string, string[]>();
  for (const message of registry.listMessages()) {
    const current = messageIdsBySession.get(message.sessionId);
    if (current) {
      current.push(message.id);
    } else {
      messageIdsBySession.set(message.sessionId, [message.id]);
    }
  }

  const records: SessionCleanupRecord[] = [];
  for (const session of removableSessions) {
    const removedMessageIds = messageIdsBySession.get(session.id) ?? [];
    for (const messageId of removedMessageIds) {
      registry.deleteMessage(messageId);
    }
    registry.deleteSession(session.id);
    records.push({
      sessionId: session.id,
      removedMessageIds,
    });
  }

  return records;
}
