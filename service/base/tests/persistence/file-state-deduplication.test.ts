import { copyFile, mkdtemp, open, readFile, rm, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { FileMailStateStore } from "../../src/persistence/file-state-store.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile), open: vi.fn(actual.open),
    copyFile: vi.fn((source, target) => actual.copyFile(source, target)) };
});

let directory: string;
beforeEach(async () => {
  vi.mocked(writeFile).mockClear();
  vi.mocked(copyFile).mockClear();
  vi.mocked(open).mockClear();
  directory = await mkdtemp(join(tmpdir(), "easyemail-file-dedup-"));
});
afterEach(async () => {
  vi.mocked(writeFile).mockRestore();
  vi.mocked(copyFile).mockRestore();
  vi.mocked(open).mockRestore();
  await rm(directory, { recursive: true, force: true });
});

function fixture(maxCachedSnapshotBytes?: number) {
  const filePath = join(directory, "state.json");
  const snapshot = new MailRegistry().snapshot();
  const store = new FileMailStateStore({ filePath, maxCachedSnapshotBytes });
  return { store, snapshot, filePath };
}

describe("file snapshot write deduplication", () => {
  it("does not rewrite an identical successful snapshot", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    const before = await stat(filePath);
    vi.mocked(writeFile).mockClear();
    await store.saveSnapshot(structuredClone(snapshot));
    expect(writeFile).not.toHaveBeenCalled();
    expect((await stat(filePath)).mtimeMs).toBe(before.mtimeMs);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("detects in-place mutations without trusting object identity", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "原文" });
    await store.saveSnapshot(snapshot);
    snapshot.messages[0]!.textBody = "更新后的正文";
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8")).messages[0].textBody).toBe("更新后的正文");
  });

  it("repairs a removed or externally replaced destination", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    await unlink(filePath);
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    await writeFile(filePath, "external replacement", "utf8");
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("does not mark a failed write as persisted and retries it", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now" });
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("test_write_failure"));
    await expect(store.saveSnapshot(snapshot)).rejects.toThrow("test_write_failure");
    expect(JSON.parse(await readFile(filePath, "utf8")).messages).toEqual([]);
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("limits retained serialized bytes and permits disabling the cache", async () => {
    for (const maxCachedSnapshotBytes of [0, 1]) {
      const { store, snapshot } = fixture(maxCachedSnapshotBytes);
      await store.saveSnapshot(snapshot);
      vi.mocked(writeFile).mockClear();
      await store.saveSnapshot(snapshot);
      expect(writeFile).toHaveBeenCalledOnce();
    }
  });

  it("uses a cloned temporary file for a small equal-length change", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "alpha" });
    await store.saveSnapshot(snapshot);
    vi.mocked(writeFile).mockClear();
    snapshot.messages[0]!.textBody = "bravo";
    await store.saveSnapshot(snapshot);
    expect(copyFile).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("falls back to full atomic writes when the filesystem cannot clone", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "alpha" });
    await store.saveSnapshot(snapshot);
    vi.mocked(copyFile).mockRejectedValueOnce(Object.assign(new Error("unsupported"), { code: "ENOTSUP" }));
    snapshot.messages[0]!.textBody = "bravo";
    await store.saveSnapshot(snapshot);
    expect(copyFile).toHaveBeenCalledOnce();
    vi.mocked(copyFile).mockClear();
    snapshot.messages[0]!.textBody = "delta";
    await store.saveSnapshot(snapshot);
    expect(copyFile).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("does not publish a clone whose source changed during the copy", async () => {
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "alpha" });
    await store.saveSnapshot(snapshot);
    vi.mocked(copyFile).mockImplementationOnce(async (source, target) => {
      await actual.copyFile(source, target);
      await actual.writeFile(filePath, "external source replacement", "utf8");
    });
    snapshot.messages[0]!.textBody = "bravo";
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("closes a failed clone patch and leaves the prior snapshot intact", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "alpha" });
    await store.saveSnapshot(snapshot);
    const close = vi.fn().mockResolvedValue(undefined);
    vi.mocked(open).mockResolvedValueOnce({ write: vi.fn().mockResolvedValue({ bytesWritten: 0 }), close } as unknown as FileHandle);
    snapshot.messages[0]!.textBody = "bravo";
    await expect(store.saveSnapshot(snapshot)).rejects.toThrow("FILE_SNAPSHOT_CLONE_WRITE_FAILED");
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(filePath, "utf8")).messages[0].textBody).toBe("alpha");
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("patches correctly at serialization block boundaries", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "a".repeat(150_000) });
    await store.saveSnapshot(snapshot);
    for (const offset of [0, 65_535, 65_536, 70_000, 149_999]) {
      const text = snapshot.messages[0]!.textBody!;
      snapshot.messages[0]!.textBody = text.slice(0, offset) + "b" + text.slice(offset + 1);
      await store.saveSnapshot(snapshot);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    }
  });
});
