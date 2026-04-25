let sequence = 0;

export function createId(prefix: string, now: Date = new Date()): string {
  sequence += 1;
  const stamp = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${prefix}_${stamp}_${sequence.toString().padStart(4, "0")}`;
}
