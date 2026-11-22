import { describe, expect, it } from "vitest";
import { getFileSnapshotChangedRanges } from "../../src/persistence/file-snapshot-diff.js";

describe("bounded file snapshot diff", () => {
  it("rejects different lengths and returns no ranges for identical buffers", () => {
    expect(getFileSnapshotChangedRanges(Buffer.alloc(10), Buffer.alloc(11))).toBeUndefined();
    expect(getFileSnapshotChangedRanges(Buffer.alloc(10), Buffer.alloc(10))).toEqual([]);
  });

  it("does not include unchanged blocks between distant changes", () => {
    const previous = Buffer.alloc(5 * 4096), next = Buffer.from(previous);
    next[0] = 1;
    next[next.length - 1] = 2;
    expect(getFileSnapshotChangedRanges(previous, next)).toEqual([
      { start: 0, end: 1 }, { start: next.length - 1, end: next.length },
    ]);
  });

  it("handles adjacent changed blocks and a partial final block", () => {
    const previous = Buffer.alloc(4 * 4096 + 3), next = Buffer.from(previous);
    next[4095] = 1;
    next[4096] = 2;
    next[next.length - 1] = 3;
    expect(getFileSnapshotChangedRanges(previous, next)).toEqual([
      { start: 4095, end: 4097 }, { start: next.length - 1, end: next.length },
    ]);
  });

  it("rejects patches covering more than half the snapshot", () => {
    expect(getFileSnapshotChangedRanges(Buffer.alloc(100), Buffer.alloc(100, 1))).toBeUndefined();
  });

  it("limits fragmented patches instead of issuing unbounded writes", () => {
    const previous = Buffer.alloc(258 * 4096), next = Buffer.from(previous);
    for (let index = 0; index < 129; index += 1) next[index * 8192] = 1;
    expect(getFileSnapshotChangedRanges(previous, next)).toBeUndefined();
  });

  it("reconstructs deterministic byte mutations exactly without overlap", () => {
    let seed = 17;
    for (let iteration = 0; iteration < 20; iteration += 1) {
      const previous = Buffer.alloc(32 * 4096 + iteration), next = Buffer.from(previous);
      for (let mutation = 0; mutation < 7; mutation += 1) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        next[seed % next.length] = mutation + 1;
      }
      const ranges = getFileSnapshotChangedRanges(previous, next);
      expect(ranges).toBeDefined();
      let previousEnd = 0;
      const reconstructed = Buffer.from(previous);
      for (const range of ranges!) {
        expect(range.start).toBeGreaterThanOrEqual(previousEnd);
        expect(range.end).toBeGreaterThan(range.start);
        next.copy(reconstructed, range.start, range.start, range.end);
        previousEnd = range.end;
      }
      expect(reconstructed.equals(next)).toBe(true);
    }
  });
});
