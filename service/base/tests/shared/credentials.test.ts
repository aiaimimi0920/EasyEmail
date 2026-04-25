import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSetDefinition } from "../../src/shared/credentials.js";
import {
  clearCredentialRuntimeState,
  createBasicAuthCredentialSetFromFile,
  getCredentialAvailabilitySummary,
  getCredentialItemStatus,
  markCredentialCriticalFailure,
  markCredentialCooldownUntilNextResetWindow,
  markCredentialSuccess,
  selectCredentialItem,
} from "../../src/shared/credentials.js";

function createCredentialSet(): CredentialSetDefinition {
  return {
    id: "test-set",
    displayName: "Test Set",
    useCases: ["generate"],
    strategy: "round-robin",
    priority: 100,
    items: [
      { id: "key-a", label: "Key A", value: "key-a", metadata: {} },
      { id: "key-b", label: "Key B", value: "key-b", metadata: {} },
    ],
    metadata: {},
  };
}

describe("credential reset-window cooldowns", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.useRealTimers();
  });

  it("requires three consecutive critical failures before cooling a credential", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T01:30:00.000Z"));

    const namespace = "mail:test:provider";
    const set = createCredentialSet();

    expect(markCredentialCriticalFailure(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    })).toEqual({
      cooled: false,
      failureCount: 1,
    });
    expect(getCredentialItemStatus(namespace, set, set.items[0]!)).toBe("active");

    expect(markCredentialCriticalFailure(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    })).toEqual({
      cooled: false,
      failureCount: 2,
    });
    expect(getCredentialItemStatus(namespace, set, set.items[0]!)).toBe("active");

    markCredentialSuccess(namespace, set, set.items[0]!);
    expect(markCredentialCriticalFailure(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    })).toEqual({
      cooled: false,
      failureCount: 1,
    });

    expect(markCredentialCriticalFailure(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    })).toEqual({
      cooled: false,
      failureCount: 2,
    });
    expect(markCredentialCriticalFailure(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    })).toEqual({
      cooled: true,
      failureCount: 3,
    });
    expect(getCredentialItemStatus(namespace, set, set.items[0]!)).toBe("rate-limited");
  });

  it("releases reset-window cooled keys at the next UTC reset boundary", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T01:30:00.000Z"));

    const namespace = "mail:test:provider";
    const set = createCredentialSet();

    markCredentialCooldownUntilNextResetWindow(namespace, set, set.items[0]!, {
      status: "rate-limited",
      error: "status 429",
      now: new Date(),
    });

    expect(getCredentialItemStatus(namespace, set, set.items[0]!)).toBe("rate-limited");
    expect(selectCredentialItem({
      namespace,
      sets: [set],
      useCase: "generate",
    })?.item.id).toBe("key-b");

    expect(getCredentialAvailabilitySummary(namespace, [set], "generate")).toEqual({
      configuredCount: 2,
      availableCount: 1,
      coolingCount: 0,
      rateLimitedCount: 1,
      exhaustedCount: 0,
      invalidCount: 0,
      disabledCount: 0,
      resetWindowCoolingCount: 1,
      timedCoolingCount: 0,
    });

    vi.setSystemTime(new Date("2026-04-04T06:00:00.000Z"));

    expect(getCredentialItemStatus(namespace, set, set.items[0]!)).toBe("active");
    expect(getCredentialAvailabilitySummary(namespace, [set], "generate")).toEqual({
      configuredCount: 2,
      availableCount: 2,
      coolingCount: 0,
      rateLimitedCount: 0,
      exhaustedCount: 0,
      invalidCount: 0,
      disabledCount: 0,
      resetWindowCoolingCount: 0,
      timedCoolingCount: 0,
    });
  });
});

describe("basic auth credential files", () => {
  it("parses username password lines from file", async () => {
    const folder = await mkdtemp(join(tmpdir(), "easy-email-basic-auth-"));
    const filePath = join(folder, "accounts.txt");

    await writeFile(filePath, [
      "# comment",
      "demo@2925.com|secret-1",
      "label-2|demo2@2925.com|secret-2",
    ].join("\n"), "utf8");

    const set = createBasicAuthCredentialSetFromFile(filePath, {
      id: "mail2925-file",
      displayName: "2925 Accounts",
      useCases: ["generate", "poll"],
    });

    expect(set?.items).toEqual([
      {
        id: "item-1",
        label: "demo....com",
        username: "demo@2925.com",
        password: "secret-1",
        metadata: {},
      },
      {
        id: "item-2",
        label: "label-2",
        username: "demo2@2925.com",
        password: "secret-2",
        metadata: {},
      },
    ]);
  });
});
