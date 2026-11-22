import { copyFile, mkdtemp, open, readFile, rm, writeFile, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { FileMailStateStore } from "../../src/persistence/file-state-store.js";
import { createCloudflareInstance } from "../providers/cloudflare-temp-email-test-support.js";

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
  directory = await mkdtemp(join(tmpdir(), "easyemail-file-ranges-"));
});
afterEach(async () => {
  vi.mocked(writeFile).mockRestore();
  vi.mocked(copyFile).mockRestore();
  vi.mocked(open).mockRestore();
  await rm(directory, { recursive: true, force: true });
});

function fixture() {
  const instances = Array.from({ length: 3 }, (_, index) => ({
    ...createCloudflareInstance(), id: `instance-${index}`, averageLatencyMs: 9,
    metadata: { domain: "example.test", stablePayload: `stable-${index}:` + "固定域😀".repeat(16_000) },
  }));
  const snapshot = new MailRegistry({ instances }).snapshot();
  snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "a".repeat(1_000_000) });
  const filePath = join(directory, "state.json");
  return { snapshot, filePath, store: new FileMailStateStore({ filePath }) };
}

async function observePatches(maxWriteBytes = Number.POSITIVE_INFINITY) {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const writes: { bytes: number; position: number }[] = [];
  vi.mocked(open).mockImplementation(async (...args) => {
    const file = await actual.open(...args);
    const write = file.write.bind(file);
    const patchWrite = async (buffer: Buffer, offset: number, length: number, position: number) => {
      const result = await write(buffer, offset, Math.min(length, maxWriteBytes), position);
      writes.push({ bytes: result.bytesWritten, position });
      return result;
    };
    vi.spyOn(file, "write").mockImplementation(patchWrite as unknown as FileHandle["write"]);
    return file;
  });
  return writes;
}

describe("bounded incremental snapshot patches", () => {
  it("patches separated instance health tails without copying stable metadata between them", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    vi.mocked(writeFile).mockClear();
    const writes = await observePatches();
    for (const instance of snapshot.instances) {
      instance.averageLatencyMs = 1234;
      instance.updatedAt = "2026-10-28T00:00:00.000Z";
    }
    await store.saveSnapshot(snapshot);
    expect(copyFile).toHaveBeenCalledOnce();
    expect(writeFile).not.toHaveBeenCalled();
    expect(writes.length).toBeGreaterThanOrEqual(3);
    expect(writes.reduce((sum, write) => sum + write.bytes, 0)).toBeLessThanOrEqual(3 * 8192);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("keeps later stable instance bytes at the same position through operational-field growth", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    const before = await readFile(filePath);
    snapshot.instances[0]!.averageLatencyMs = 123456;
    snapshot.instances[0]!.status = "degraded";
    await store.saveSnapshot(snapshot);
    const after = await readFile(filePath);
    expect(after.length).toBe(before.length);
    expect(after.indexOf("stable-1:")).toBe(before.indexOf("stable-1:"));
    expect(after.indexOf("stable-2:")).toBe(before.indexOf("stable-2:"));
    expect(JSON.parse(after.toString("utf8"))).toEqual(snapshot);
  });

  it("completes partial writes across separated patches before publishing", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    const writes = await observePatches(7);
    snapshot.instances[0]!.averageLatencyMs = 10;
    snapshot.instances[2]!.averageLatencyMs = 10;
    await store.saveSnapshot(snapshot);
    expect(writes.length).toBeGreaterThan(2);
    expect(writes.reduce((sum, write) => sum + write.bytes, 0)).toBeLessThanOrEqual(4 * 4096);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });

  it("retains the previous destination when a later patch fails and can retry", async () => {
    const { store, snapshot, filePath } = fixture();
    await store.saveSnapshot(snapshot);
    const before = await readFile(filePath);
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let calls = 0;
    const close = vi.fn();
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await actual.open(...args), write = file.write.bind(file), realClose = file.close.bind(file);
      return { write: async (...values: Parameters<FileHandle["write"]>) => {
        if (++calls === 2) throw new Error("later_patch_failed");
        return write(...values);
      }, close: async () => { close(); await realClose(); } } as unknown as FileHandle;
    });
    snapshot.instances[0]!.averageLatencyMs = 1234;
    snapshot.instances[2]!.averageLatencyMs = 1234;
    await expect(store.saveSnapshot(snapshot)).rejects.toThrow("later_patch_failed");
    expect(close).toHaveBeenCalledOnce();
    expect((await readFile(filePath)).equals(before)).toBe(true);
    await store.saveSnapshot(snapshot);
    expect(JSON.parse(await readFile(filePath, "utf8"))).toEqual(snapshot);
  });
});
