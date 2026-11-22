import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRuntimeSignalShutdown } from "../../src/runtime/signal-shutdown.js";

afterEach(() => vi.useRealTimers());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("runtime signal shutdown", () => {
  it.each(["SIGTERM", "SIGINT"])("waits for close on %s and ignores repeated signals", async (signal) => {
    const signals = new EventEmitter();
    const pending = deferred<void>();
    const close = vi.fn(() => pending.promise);
    const exit = vi.fn();
    const shutdown = installRuntimeSignalShutdown(Promise.resolve({ close }), { signals, exit });
    signals.emit(signal);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    await Promise.resolve();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    pending.resolve();
    await shutdown.stop();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);
    expect(signals.listenerCount("SIGINT")).toBe(0);
  });

  it("handles a signal while startup is still pending", async () => {
    const signals = new EventEmitter();
    const starting = deferred<{ close(): Promise<void> }>();
    const exit = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const shutdown = installRuntimeSignalShutdown(starting.promise, { signals, exit });
    signals.emit("SIGTERM");
    expect(shutdown.isStopping()).toBe(true);
    expect(exit).not.toHaveBeenCalled();
    starting.resolve({ close });
    await shutdown.stop();
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(["startup", "close"])("reports a sanitized %s failure", async (phase) => {
    const signals = new EventEmitter();
    const report = vi.fn();
    const exit = vi.fn();
    const error = new Error("secret test value");
    const runtime = phase === "startup" ? Promise.reject(error) : Promise.resolve({
      close: async () => { throw error; },
    });
    const shutdown = installRuntimeSignalShutdown(runtime, { signals, report, exit });
    await shutdown.stop();
    expect(report).toHaveBeenCalledExactlyOnceWith("easy_email_shutdown_failed");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("uses a nonzero forced-exit deadline without reporting successful durability", async () => {
    vi.useFakeTimers();
    const signals = new EventEmitter();
    const pending = deferred<void>();
    const report = vi.fn();
    const exit = vi.fn();
    const shutdown = installRuntimeSignalShutdown(Promise.resolve({ close: () => pending.promise }), {
      signals, report, exit, timeoutMs: 100,
    });
    signals.emit("SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    expect(report).toHaveBeenCalledExactlyOnceWith("easy_email_shutdown_timeout");
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    pending.resolve();
    await shutdown.stop();
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it("still exits when the diagnostic logger fails", async () => {
    const exit = vi.fn();
    const shutdown = installRuntimeSignalShutdown(Promise.resolve({
      close: async () => { throw new Error("secret failure"); },
    }), { signals: new EventEmitter(), exit, report: () => { throw new Error("closed log"); } });
    await shutdown.stop();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
