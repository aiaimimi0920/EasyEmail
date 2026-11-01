import { describe, expect, it, vi } from "vitest";
import type { MailboxSession, ObservedMessage } from "../../src/domain/models.js";
import { MailRegistry } from "../../src/domain/registry.js";
import { cleanupMailboxMessages } from "../../src/workers/cleanup-messages.js";

function session(id: string, status: MailboxSession["status"] = "expired"): MailboxSession {
  return {
    id, status, hostId: "test", providerTypeKey: "mailtm", providerInstanceId: "test",
    emailAddress: `${id}@example.test`, mailboxRef: id,
    createdAt: "2026-10-25T00:00:00.000Z", metadata: {},
  };
}

function message(id: string, sessionId: string, minute: number): ObservedMessage {
  return {
    id, sessionId, providerInstanceId: "test",
    observedAt: `2026-10-25T00:${String(minute).padStart(2, "0")}:00.000Z`,
  };
}

describe("message retention maintenance", () => {
  it("retains newest messages per closed session without touching open or orphan messages", () => {
    const registry = new MailRegistry({
      sessions: [session("closed"), session("open", "open"), session("resolved", "resolved"), session("empty")],
      messages: [
        message("old", "closed", 0), message("new", "closed", 2), message("middle", "closed", 1),
        message("open-old", "open", 0), message("open-new", "open", 1),
        message("resolved-old", "resolved", 0), message("resolved-new", "resolved", 1),
        message("orphan", "missing", 0),
      ],
    });
    expect(cleanupMailboxMessages(registry, { keepRecentCount: 1 })).toEqual([
      { sessionId: "closed", removedMessageIds: ["middle", "old"] },
      { sessionId: "resolved", removedMessageIds: ["resolved-old"] },
    ]);
    expect(registry.listMessages().map((item) => item.id)).toEqual([
      "new", "open-old", "open-new", "resolved-new", "orphan",
    ]);
  });

  it("preserves stable ordering for equal timestamps and supports explicit open-session cleanup", () => {
    const registry = new MailRegistry({
      sessions: [session("open", "open")],
      messages: [message("first", "open", 0), message("second", "open", 0)],
    });
    expect(cleanupMailboxMessages(registry, { keepRecentCount: 1, onlyResolvedOrExpired: false })).toEqual([
      { sessionId: "open", removedMessageIds: ["second"] },
    ]);
    expect(cleanupMailboxMessages(registry, { keepRecentCount: 0, onlyResolvedOrExpired: false })).toEqual([
      { sessionId: "open", removedMessageIds: ["first"] },
    ]);
  });

  it("keeps the default five messages and is idempotent", () => {
    const registry = new MailRegistry({
      sessions: [session("closed")],
      messages: Array.from({ length: 7 }, (_, index) => message(String(index), "closed", index)),
    });
    expect(cleanupMailboxMessages(registry)).toEqual([
      { sessionId: "closed", removedMessageIds: ["1", "0"] },
    ]);
    expect(cleanupMailboxMessages(registry)).toEqual([]);
  });

  it("scans the message collection once rather than once per retained session", () => {
    const registry = new MailRegistry({
      sessions: Array.from({ length: 5000 }, (_, index) => session(String(index))),
      messages: Array.from({ length: 2914 }, (_, index) => message(String(index), String(index), 0)),
    });
    const allMessages = vi.spyOn(registry, "listMessages");
    const perSession = vi.spyOn(registry, "listMessagesBySession");
    expect(cleanupMailboxMessages(registry)).toEqual([]);
    expect(perSession.mock.calls.length).toBe(0);
    expect(allMessages).toHaveBeenCalledTimes(1);
  });
});
