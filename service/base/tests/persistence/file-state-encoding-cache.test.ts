import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { encodeFileSnapshot } from "../../src/persistence/file-snapshot-codec.js";
import { FileMailStateStore } from "../../src/persistence/file-state-store.js";

vi.mock("../../src/persistence/file-snapshot-codec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/persistence/file-snapshot-codec.js")>();
  return { ...actual, encodeFileSnapshot: vi.fn(actual.encodeFileSnapshot) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let directory: string;
beforeEach(async () => {
  vi.mocked(encodeFileSnapshot).mockClear();
  vi.mocked(writeFile).mockClear();
  directory = await mkdtemp(join(tmpdir(), "easyemail-encoding-cache-"));
});
afterEach(async () => {
  vi.mocked(writeFile).mockRestore();
  await rm(directory, { recursive: true, force: true });
});
function fixture(maxCachedSnapshotBytes?: number) {
  const snapshot = new MailRegistry().snapshot();
  snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now",
    textBody: "正文😀".repeat(40_000), actionLinks: [{ url: "https://example.test/old", source: "text" }] });
  const filePath = join(directory, "state.json");
  return { snapshot, filePath, store: new FileMailStateStore({ filePath, maxCachedSnapshotBytes }) };
}

describe("successful snapshot encoding reuse", () => {
  it("does not re-encode equal data even when all containers are replaced", async () => {
    const { store, snapshot } = fixture();
    await store.saveSnapshot(snapshot);
    vi.mocked(encodeFileSnapshot).mockClear();
    await store.saveSnapshot(structuredClone(snapshot));
    expect(encodeFileSnapshot).not.toHaveBeenCalled();
  });

  it("reuses saved bytes to repair an externally replaced destination", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    await writeFile(filePath, "external replacement", "utf8");
    vi.mocked(encodeFileSnapshot).mockClear();
    await store.saveSnapshot(snapshot);
    expect(encodeFileSnapshot).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("detects in-place changes in nested arrays and message bodies", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    vi.mocked(encodeFileSnapshot).mockClear();
    snapshot.messages[0]!.textBody += "新的正文";
    snapshot.messages[0]!.actionLinks![0]!.url = "https://example.test/new";
    await store.saveSnapshot(snapshot);
    expect(encodeFileSnapshot).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("does not capture mutations after asynchronous persistence has started", async () => {
    const { store, snapshot, filePath } = fixture();
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(writeFile).mockImplementationOnce(async (...args) => { await waiting; await actual.writeFile(...args); });
    const first = store.saveSnapshot(snapshot);
    snapshot.messages[0]!.textBody = "mutated while first write is waiting";
    release(); await first;
    vi.mocked(encodeFileSnapshot).mockClear();
    await store.saveSnapshot(snapshot);
    expect(encodeFileSnapshot).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("keeps only successful data in its comparison state", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    snapshot.messages[0]!.textBody = "new body of a different byte length";
    vi.mocked(writeFile).mockRejectedValueOnce(new Error("controlled_write_failure"));
    await expect(store.saveSnapshot(snapshot)).rejects.toThrow("controlled_write_failure");
    vi.mocked(encodeFileSnapshot).mockClear();
    await store.saveSnapshot(snapshot);
    expect(encodeFileSnapshot).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("does not retain comparison state when the byte cache is disabled or too small", async () => {
    for (const maxCachedSnapshotBytes of [0, 1]) {
      const { store, snapshot } = fixture(maxCachedSnapshotBytes);
      await store.saveSnapshot(snapshot);
      vi.mocked(encodeFileSnapshot).mockClear();
      await store.saveSnapshot(snapshot);
      expect(encodeFileSnapshot).toHaveBeenCalledOnce();
    }
  });
});
