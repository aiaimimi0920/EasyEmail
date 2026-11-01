import type { EasyEmailSnapshot, ProviderInstance } from "../domain/models.js";

const MIN_ALIGNED_SNAPSHOT_BYTES = 256 * 1024;
const INSTANCE_ALIGNMENT_BYTES = 4096;

interface EncodedPart {
  text: string;
  bytes: number;
  aligned?: boolean;
}

function part(text: string, aligned = false): EncodedPart {
  return { text, bytes: Buffer.byteLength(text, "utf8"), aligned };
}

function instanceParts(instances: ProviderInstance[]): EncodedPart[] {
  const parts = [part('"instances":[')];
  for (const [index, instance] of instances.entries()) {
    if (index > 0) parts.push(part(","));
    // Registry snapshots contain plain records. Keep changing health fields after large configuration data.
    const { status, healthScore, averageLatencyMs, updatedAt, ...configuration } = instance;
    parts.push(part(JSON.stringify({ ...configuration, status, healthScore, averageLatencyMs, updatedAt }), true));
  }
  parts.push(part("]"));
  return parts;
}

function padding(part: EncodedPart): number {
  return part.aligned ? (INSTANCE_ALIGNMENT_BYTES - part.bytes % INSTANCE_ALIGNMENT_BYTES) % INSTANCE_ALIGNMENT_BYTES : 0;
}

export function encodeFileSnapshot(snapshot: EasyEmailSnapshot): Buffer {
  const sections: EncodedPart[][] = Object.entries(snapshot).flatMap(([key, value]) => {
    if (key === "instances" && Array.isArray(value)) return [instanceParts(value)];
    // Wrapping preserves JSON's property-key semantics for values with toJSON().
    const text = JSON.stringify({ [key]: value }).slice(1, -1);
    return text ? [[part(text)]] : [];
  });
  const parts = sections.flat();
  const compactBytes = 2 + Math.max(0, sections.length - 1) + parts.reduce((sum, value) => sum + value.bytes, 0);
  if (compactBytes < MIN_ALIGNED_SNAPSHOT_BYTES) return Buffer.from(JSON.stringify(snapshot), "utf8");

  // Only instance records get slack; other sections remain compact.
  const content = Buffer.allocUnsafe(compactBytes + parts.reduce((sum, value) => sum + padding(value), 0));
  let offset = 0;
  content[offset++] = 0x7b;
  for (const [index, section] of sections.entries()) {
    if (index > 0) content[offset++] = 0x2c;
    for (const value of section) {
      offset += content.write(value.text, offset, value.bytes, "utf8");
      const slack = padding(value);
      content.fill(0x20, offset, offset + slack);
      offset += slack;
    }
  }
  content[offset++] = 0x7d;
  if (offset !== content.byteLength) throw new Error("FILE_SNAPSHOT_ENCODING_LENGTH_MISMATCH");
  return content;
}
