import { describe, expect, it } from "vitest";
import { MailRegistry } from "../../src/domain/registry.js";
import { captureFileSnapshotState } from "../../src/persistence/file-snapshot-comparison.js";

function fixture() {
  const snapshot = new MailRegistry().snapshot();
  snapshot.messages.push({ id: "m", sessionId: "s", providerInstanceId: "p", observedAt: "now", textBody: "汉字😀" });
  return snapshot;
}

describe("plain snapshot comparison capture", () => {
  it("copies containers independently while preserving JSON data", () => {
    const snapshot = fixture();
    const state = captureFileSnapshotState(snapshot)!;
    expect(JSON.stringify(state)).toBe(JSON.stringify(snapshot));
    expect(state.messages).not.toBe(snapshot.messages);
    snapshot.messages[0]!.textBody = "changed";
    expect(state.messages[0]!.textBody).toBe("汉字😀");
  });

  it("preserves an own __proto__ metadata key without prototype assignment", () => {
    const snapshot = fixture();
    snapshot.strategies.push({ id: "s", key: "free-first", displayName: "s", description: "s",
      metadata: JSON.parse('{"__proto__":"retained"}') });
    const state = captureFileSnapshotState(snapshot)!;
    expect(Object.hasOwn(state.strategies[0]!.metadata, "__proto__")).toBe(true);
    expect(JSON.stringify(state)).toBe(JSON.stringify(snapshot));
  });

  it("does not invoke accessor properties during capture", () => {
    const snapshot = fixture();
    let calls = 0;
    Object.defineProperty(snapshot, "messages", { enumerable: true, get() { calls += 1; return []; } });
    expect(captureFileSnapshotState(snapshot)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("reuses only independently captured unchanged containers", () => {
    const snapshot = fixture();
    const first = captureFileSnapshotState(snapshot)!;
    expect(captureFileSnapshotState(structuredClone(snapshot), first)).toBe(first);
    snapshot.messages[0]!.textBody = "new body";
    const next = captureFileSnapshotState(snapshot, first)!;
    expect(next).not.toBe(first);
    expect(next.messages).not.toBe(first.messages);
    expect(next.sessions).toBe(first.sessions);
    expect(first.messages[0]!.textBody).toBe("汉字😀");
    expect(next.messages[0]!.textBody).toBe("new body");
    expect(captureFileSnapshotState(snapshot, next)).toBe(next);
  });

  it("falls back for custom serialization, non-plain values and cycles", () => {
    for (const value of [new Date(), { toJSON: () => "custom" }, { hidden: undefined }, 1n, () => "value"]) {
      const snapshot = fixture();
      Object.assign(snapshot, { extension: value });
      if (value && typeof value === "object" && "hidden" in value) Object.defineProperty(value, "hidden", { enumerable: false });
      expect(captureFileSnapshotState(snapshot)).toBeUndefined();
    }
    const snapshot = fixture();
    Object.assign(snapshot, { cycle: snapshot });
    expect(captureFileSnapshotState(snapshot)).toBeUndefined();
  });

  it("preserves holes, undefined values and ordinary array data", () => {
    const snapshot = fixture();
    const array = new Array(3);
    array[1] = undefined;
    array[2] = "last";
    Object.assign(snapshot, { extension: array, omitted: undefined });
    const state = captureFileSnapshotState(snapshot);
    expect(JSON.stringify(state)).toBe(JSON.stringify(snapshot));
  });

  it("bounds captured structures and falls back rather than retaining partial state", () => {
    const snapshot = fixture();
    Object.assign(snapshot, { extension: new Array(250_001) });
    expect(captureFileSnapshotState(snapshot)).toBeUndefined();
    expect(captureFileSnapshotState(fixture())).toBeDefined();
  });

  it("rejects proxies without triggering their property traps", () => {
    const snapshot = fixture();
    let calls = 0;
    Object.assign(snapshot, { extension: new Proxy({}, { ownKeys() { calls += 1; return []; } }) });
    expect(captureFileSnapshotState(snapshot)).toBeUndefined();
    expect(calls).toBe(0);
  });

  it("independently enforces property, object and depth capture limits", () => {
    for (const extension of [new Array(250_000).fill(null), Array.from({ length: 30_001 }, () => ({}))]) {
      const snapshot = fixture();
      Object.assign(snapshot, { extension });
      expect(captureFileSnapshotState(snapshot)).toBeUndefined();
    }
    let extension: Record<string, unknown> = {};
    for (let index = 0; index < 65; index += 1) extension = { child: extension };
    const snapshot = fixture();
    Object.assign(snapshot, { extension });
    expect(captureFileSnapshotState(snapshot)).toBeUndefined();
  });
});
