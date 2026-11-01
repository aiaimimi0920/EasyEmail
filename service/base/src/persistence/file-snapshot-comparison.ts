import type { EasyEmailSnapshot } from "../domain/models.js";
import { types } from "node:util";

const MAX_OBJECTS = 30_000;
const MAX_PROPERTIES = 250_000;
const MAX_DEPTH = 64;

/** Capture containers, not string bytes; never trust mutable registry object identities. */
export function captureFileSnapshotState(
  snapshot: EasyEmailSnapshot,
  previousState?: EasyEmailSnapshot,
): EasyEmailSnapshot | undefined {
  let objects = 0;
  let properties = 0;
  let cacheable = true;
  const active = new WeakSet<object>();
  const capture = (value: unknown, previous: unknown, depth: number): unknown => {
    if (!cacheable) return undefined;
    const kind = typeof value;
    if (value === null || kind === "undefined" || kind === "string" || kind === "number" || kind === "boolean") return value;
    if (typeof value !== "object" || types.isProxy(value) || depth > MAX_DEPTH || ++objects > MAX_OBJECTS) {
      cacheable = false;
      return undefined;
    }
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    const keys = Object.keys(value);
    properties += keys.length;
    if (active.has(value) || properties > MAX_PROPERTIES || "toJSON" in value
      || Object.getOwnPropertySymbols(value).length > 0
      || Object.getOwnPropertyNames(value).length !== keys.length + (array ? 1 : 0)
      || (array ? prototype !== Array.prototype || value.length > MAX_PROPERTIES
        : prototype !== Object.prototype && prototype !== null)) {
      cacheable = false;
      return undefined;
    }
    const old = previous && typeof previous === "object" && Object.getPrototypeOf(previous) === prototype
      ? previous as Record<string, unknown> : undefined;
    const oldKeys = old ? Object.keys(old) : [];
    const matching = old !== undefined && oldKeys.length === keys.length
      && keys.every((key, index) => key === oldKeys[index]) && (!array || value.length === (previous as unknown[]).length);
    let copy: Record<string, unknown> | undefined = matching ? undefined
      : array ? new Array(value.length) as unknown as Record<string, unknown> : Object.create(prototype);
    active.add(value);
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      const index = Number(key);
      if (!("value" in descriptor) || (array && (!Number.isInteger(index) || String(index) !== key || index < 0 || index >= value.length))) {
        cacheable = false;
        break;
      }
      const child = capture(descriptor.value, matching ? old![key] : undefined, depth + 1);
      if (!cacheable) break;
      if (!copy && !Object.is(child, old![key])) {
        copy = array ? (previous as unknown[]).slice() as unknown as Record<string, unknown>
          : prototype === null ? Object.assign(Object.create(null), old) : { ...old };
      }
      if (copy) {
        if (key === "__proto__") Object.defineProperty(copy, key, { value: child, enumerable: true, configurable: true, writable: true });
        else copy[key] = child;
      }
    }
    active.delete(value);
    return copy ?? previous;
  };
  try {
    const state = capture(snapshot, previousState, 0);
    return cacheable ? state as EasyEmailSnapshot : undefined;
  } catch {
    // Non-plain inputs keep the existing encoder's behavior and error handling.
    return undefined;
  }
}
