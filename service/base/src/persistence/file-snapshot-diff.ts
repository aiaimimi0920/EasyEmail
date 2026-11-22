export interface FileSnapshotChangedRange {
  start: number;
  end: number;
}

const BLOCK_BYTES = 4096;
const MAX_RANGES = 128;

/** Undefined means a full atomic write is preferable; never return an incomplete diff. */
export function getFileSnapshotChangedRanges(previous: Buffer, next: Buffer): FileSnapshotChangedRange[] | undefined {
  if (previous.byteLength !== next.byteLength) return undefined;
  const ranges: FileSnapshotChangedRange[] = [];
  let changedBytes = 0;
  let pendingStart = -1;
  const append = (end: number): boolean => {
    let start = pendingStart;
    while (start < end && previous[start] === next[start]) start += 1;
    while (end > start && previous[end - 1] === next[end - 1]) end -= 1;
    if (start < end) {
      ranges.push({ start, end });
      changedBytes += end - start;
    }
    pendingStart = -1;
    return ranges.length <= MAX_RANGES && changedBytes <= next.byteLength / 2;
  };
  for (let offset = 0; offset < next.byteLength; offset += BLOCK_BYTES) {
    const end = Math.min(offset + BLOCK_BYTES, next.byteLength);
    if (!previous.subarray(offset, end).equals(next.subarray(offset, end))) {
      if (pendingStart < 0) pendingStart = offset;
    } else if (pendingStart >= 0 && !append(offset)) {
      return undefined;
    }
  }
  if (pendingStart >= 0 && !append(next.byteLength)) return undefined;
  return ranges;
}
