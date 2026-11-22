import { afterEach, describe, expect, it, vi } from "vitest";
import { runSqliteHelper } from "../../src/persistence/sqlite-helper-process.js";
import { SqliteMailStateStore } from "../../src/persistence/sqlite-state-store.js";

vi.mock("../../src/persistence/sqlite-helper-process.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/persistence/sqlite-helper-process.js")>(),
  runSqliteHelper: vi.fn(),
}));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(runSqliteHelper).mockReset();
});

describe("SQLite operation queue budgets", () => {
  it("includes queue wait in the deadline and recovers after an expired operation", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    vi.mocked(runSqliteHelper).mockImplementationOnce(() => new Promise((resolve) => {
      finish = () => resolve(undefined);
    }));
    const store = new SqliteMailStateStore({ databasePath: "deadline-only-no-file.sqlite" });
    const first = store.loadSeed();
    await Promise.resolve();
    const queued = expect(store.getStats()).rejects.toMatchObject({ code: "SQLITE_HELPER_TIMEOUT" });
    vi.advanceTimersByTime(30_001);
    finish();
    await first;
    await queued;
    expect(runSqliteHelper).toHaveBeenCalledTimes(1);
    expect(await store.loadSeed()).toBeUndefined();
    expect(runSqliteHelper).toHaveBeenCalledTimes(2);
  });

  it("applies fallbacks to resolved output instead of to a Promise", async () => {
    vi.mocked(runSqliteHelper).mockResolvedValue(undefined);
    const store = new SqliteMailStateStore({ databasePath: "fallback-only-no-file.sqlite" });
    expect(await store.listProviderInstances()).toEqual([]);
    expect(await store.listHostBindings()).toEqual([]);
    expect(await store.listMailboxSessions()).toEqual([]);
    expect(await store.listObservedMessages()).toEqual([]);
    expect((await store.getStats()).observedMessageCount).toBe(0);
  });

  it("rejects over-budget input before spawning", async () => {
    const bytes = vi.spyOn(Buffer, "byteLength").mockReturnValue(128 * 1024 * 1024 + 1);
    const store = new SqliteMailStateStore({ databasePath: "budget-only-no-file.sqlite" });
    const result = store.loadSeed();
    bytes.mockRestore();
    await expect(result).rejects.toMatchObject({ code: "SQLITE_HELPER_QUEUE_LIMIT" });
    expect(runSqliteHelper).not.toHaveBeenCalled();
  });
});
