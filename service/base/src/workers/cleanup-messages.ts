import type { MailRegistry } from "../domain/registry.js";

import type { ObservedMessage } from "../domain/models.js";

export interface MessageCleanupOptions {
  now?: Date;
  keepRecentCount?: number;
  onlyResolvedOrExpired?: boolean;
}

export interface MessageCleanupRecord {
  sessionId: string;
  removedMessageIds: string[];
}

export function cleanupMailboxMessages(
  registry: MailRegistry,
  options: MessageCleanupOptions = {},
): MessageCleanupRecord[] {
  const keepRecentCount = options.keepRecentCount ?? 5;
  const records: MessageCleanupRecord[] = [];
  const messagesBySession = new Map<string, ObservedMessage[]>();
  for (const message of registry.listMessages()) {
    const messages = messagesBySession.get(message.sessionId);
    if (messages) {
      messages.push(message);
    } else {
      messagesBySession.set(message.sessionId, [message]);
    }
  }

  for (const session of registry.listSessions()) {
    if (options.onlyResolvedOrExpired !== false && session.status === "open") {
      continue;
    }

    const messages = (messagesBySession.get(session.id) ?? [])
      .sort((left, right) => right.observedAt.localeCompare(left.observedAt));

    const removable = messages.slice(keepRecentCount);

    if (removable.length === 0) {
      continue;
    }

    for (const message of removable) {
      registry.deleteMessage(message.id);
    }

    records.push({
      sessionId: session.id,
      removedMessageIds: removable.map((item) => item.id),
    });
  }

  return records;
}
