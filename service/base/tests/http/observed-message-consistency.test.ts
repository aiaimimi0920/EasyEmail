import { describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import type { ObservedMessage } from "../../src/domain/models.js";
import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { InMemoryMailStateDatabase } from "../../src/persistence/in-memory-database.js";
import { EasyEmailService } from "../../src/service/easy-email-service.js";

function message(id: string, sessionId = "target", extractedCode?: string): ObservedMessage {
  return { id, sessionId, providerInstanceId: "provider", observedAt: id, extractedCode };
}

function fixture() {
  const registry = new MailRegistry({ messages: [message("2026-10-24")] });
  const service = new EasyEmailService(registry);
  const repository = new InMemoryMailStateDatabase();
  const listStored = vi.spyOn(repository, "listObservedMessages");
  const sync = vi.spyOn(service, "syncObservedMessages").mockImplementation(async () => {
    const fresh = message("2026-10-25", "target", "123456");
    registry.saveMessage(fresh);
    registry.saveMessage(message("2026-10-26", "other", "654321"));
    return [fresh];
  });
  return { handler: new EasyEmailHttpHandler(service, repository), sync, listStored };
}

describe("observed-message read-after-sync consistency", () => {
  it("returns fresh filtered state without waiting for the periodic persistence flush", async () => {
    const { handler, sync, listStored } = fixture();
    const filters = { sessionId: "target", sync: true, extractedCodeOnly: true, newestFirst: true, limit: 1 };
    await expect(handler.queryObservedMessages(filters)).resolves.toEqual({
      messages: [message("2026-10-25", "target", "123456")],
    });
    expect(sync).toHaveBeenCalledWith("target");
    expect(listStored).not.toHaveBeenCalled();
    expect(filters.sync).toBe(true);
  });

  it("preserves repository queries when sync is not requested or has no session", async () => {
    const { handler, sync, listStored } = fixture();
    await expect(handler.queryObservedMessages({ sessionId: "target", sync: false })).resolves.toEqual({ messages: [] });
    await expect(handler.queryObservedMessages({ sync: true })).resolves.toEqual({ messages: [] });
    expect(sync).not.toHaveBeenCalled();
    expect(listStored).toHaveBeenCalledTimes(2);
  });

  it("propagates sync failure instead of silently returning old persisted messages", async () => {
    const { handler, sync, listStored } = fixture();
    sync.mockRejectedValueOnce(new Error("upstream unavailable"));
    await expect(handler.queryObservedMessages({ sessionId: "target", sync: true })).rejects.toThrow("upstream unavailable");
    expect(listStored).not.toHaveBeenCalled();
  });
});
