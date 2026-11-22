import { EasyEmailError } from "../domain/errors.js";
import type { MailboxSession } from "../domain/models.js";
import type { EasyEmailService } from "../service/easy-email-service.js";
import type { MailboxRefreshResult } from "./contracts.js";

export async function refreshMailboxSessions(
  service: EasyEmailService,
  sessions: readonly MailboxSession[],
  captureFailures: boolean,
): Promise<MailboxRefreshResult> {
  const refresh: MailboxRefreshResult = {
    fetchedCount: 0,
    insertedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    refreshedSessionIds: [],
    skippedSessionIds: [],
    failures: [],
  };

  for (const session of sessions) {
    if (session.status !== "open") {
      refresh.skippedCount += 1;
      refresh.skippedSessionIds.push(session.id);
      continue;
    }

    const beforeIds = new Set(
      service.getSnapshot().messages
        .filter((message) => message.sessionId === session.id)
        .map((message) => message.id),
    );
    try {
      const fetched = await service.syncObservedMessages(session.id);
      const insertedCount = service.getSnapshot().messages.filter(
        (message) => message.sessionId === session.id && !beforeIds.has(message.id),
      ).length;
      refresh.fetchedCount += fetched.length;
      refresh.insertedCount += insertedCount;
      refresh.refreshedSessionIds.push(session.id);
    } catch (error) {
      const errorCode = error instanceof EasyEmailError ? error.code : "MAILBOX_REFRESH_FAILED";
      if (!captureFailures) {
        throw new EasyEmailError(
          errorCode,
          `Unable to refresh mailbox session ${session.id}.`,
        );
      }
      refresh.failedCount += 1;
      refresh.failures.push({
        sessionId: session.id,
        errorCode,
      });
    }
  }

  return refresh;
}
