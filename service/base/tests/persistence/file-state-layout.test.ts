import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { FileMailStateStore } from "../../src/persistence/file-state-store.js";
import { createCloudflareInstance } from "../providers/cloudflare-temp-email-test-support.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile),
    copyFile: vi.fn((source, target) => actual.copyFile(source, target)) };
});

let directory: string;
beforeEach(async () => {
  vi.mocked(writeFile).mockClear();
  vi.mocked(copyFile).mockClear();
  directory = await mkdtemp(join(tmpdir(), "easyemail-file-layout-"));
});
afterEach(async () => {
  vi.mocked(writeFile).mockRestore();
  vi.mocked(copyFile).mockRestore();
  await rm(directory, { recursive: true, force: true });
});

function fixture(maxCachedSnapshotBytes?: number) {
  const snapshot = new MailRegistry({ instances: [createCloudflareInstance()] }).snapshot();
  snapshot.instances[0]!.averageLatencyMs = 9;
  snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "正文😀".repeat(40_000) });
  const filePath = join(directory, "state.json");
  return { snapshot, filePath, store: new FileMailStateStore({ filePath, maxCachedSnapshotBytes }) };
}

describe("stable file snapshot instance layout", () => {
  it("clones a large snapshot when an early latency field changes byte length", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    const before = await readFile(filePath);
    vi.mocked(writeFile).mockClear();
    snapshot.instances[0]!.averageLatencyMs = 1234;
    await store.saveSnapshot(snapshot);
    expect(copyFile).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
    expect((await readFile(filePath)).length).toBe(before.length);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    expect(await new FileMailStateStore({ filePath }).loadSeed()).toEqual(snapshot);
  });

  it("keeps JSON data and UTF-8 intact through byte-length growth and shrink", async () => {
    const { store, snapshot, filePath } = fixture();
    snapshot.instances[0]!.metadata.note = "汉字😀\\\"";
    await store.saveSnapshot(snapshot);
    vi.mocked(writeFile).mockClear();
    for (const note of ["更长的汉字和😀😀\\\"", "短", "", "\\n\"汉字😀"]) {
      snapshot.instances[0]!.metadata.note = note;
      await store.saveSnapshot(snapshot);
      expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    }
    expect(writeFile).not.toHaveBeenCalled();
    expect(copyFile).toHaveBeenCalledTimes(4);
  });

  it("preserves compact JSON for small snapshots", async () => {
    const snapshot = new MailRegistry().snapshot();
    const filePath = join(directory, "small.json");
    await new FileMailStateStore({ filePath }).saveSnapshot(snapshot);
    expect(await readFile(filePath, "utf8")).toBe(JSON.stringify(snapshot));
  });

  it("does not rewrite an identical padded snapshot", async () => {
    const { store, snapshot } = fixture();
    await store.saveSnapshot(snapshot);
    vi.mocked(writeFile).mockClear();
    await store.saveSnapshot(structuredClone(snapshot));
    expect(writeFile).not.toHaveBeenCalled();
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("falls back atomically when an instance section grows or shrinks across its bucket", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    vi.mocked(writeFile).mockClear();
    snapshot.instances[0]!.metadata.extra = "a".repeat(8192);
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    delete snapshot.instances[0]!.metadata.extra;
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
    expect(writeFile).toHaveBeenCalledTimes(2);
    expect(copyFile).not.toHaveBeenCalled();
  });

  it("includes padding in the retained-byte limit", async () => {
    const { snapshot, filePath } = fixture();
    const compactBytes = Buffer.byteLength(JSON.stringify(snapshot));
    const store = new FileMailStateStore({ filePath, maxCachedSnapshotBytes: compactBytes });
    await store.saveSnapshot(snapshot);
    expect((await readFile(filePath)).length).toBeGreaterThan(compactBytes);
    vi.mocked(writeFile).mockClear();
    await store.saveSnapshot(snapshot);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("recovers a compact legacy or externally replaced destination", async () => {
    const { store, snapshot, filePath } = fixture();
    await writeFile(filePath, JSON.stringify(snapshot), "utf8");
    expect(await store.loadSeed()).toEqual(snapshot);
    await store.saveSnapshot(snapshot);
    await writeFile(filePath, JSON.stringify(snapshot), "utf8");
    vi.mocked(writeFile).mockClear();
    snapshot.instances[0]!.averageLatencyMs = 123;
    await store.saveSnapshot(snapshot);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });
});
