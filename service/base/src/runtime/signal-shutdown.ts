import { EventEmitter } from "node:events";

export const RUNTIME_SHUTDOWN_TIMEOUT_MS = 45_000;

interface RuntimeWithClose {
  close(): Promise<void>;
}

export interface RuntimeSignalShutdownOptions {
  signals?: EventEmitter;
  timeoutMs?: number;
  exit?: (code: number) => void;
  report?: (event: string) => void;
}

export function installRuntimeSignalShutdown(
  runtime: Promise<RuntimeWithClose>,
  options: RuntimeSignalShutdownOptions = {},
) {
  const signals = options.signals ?? process;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report = options.report ?? ((event: string) => console.error(event));
  const timeoutMs = options.timeoutMs ?? RUNTIME_SHUTDOWN_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("INVALID_SHUTDOWN_TIMEOUT");
  let stopping = false;
  let finished = false;
  let stopPromise: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const detach = () => {
    signals.off("SIGTERM", onSignal);
    signals.off("SIGINT", onSignal);
    clearTimeout(timer);
  };
  const finish = (code: number, event?: string) => {
    if (finished) return;
    finished = true;
    detach();
    try {
      if (event) report(event);
    } catch {
      // A closed log stream must not prevent the bounded exit path.
    }
    exit(code);
  };
  const stop = (): Promise<void> => {
    if (stopPromise) return stopPromise;
    stopping = true;
    timer = setTimeout(() => finish(1, "easy_email_shutdown_timeout"), timeoutMs);
    stopPromise = (async () => {
      try {
        const started = await runtime;
        await started.close();
        finish(0);
      } catch {
        // Never print a raw startup/flush error, which may contain credentials.
        finish(1, "easy_email_shutdown_failed");
      }
    })();
    return stopPromise;
  };
  function onSignal() {
    void stop();
  }
  signals.on("SIGTERM", onSignal);
  signals.on("SIGINT", onSignal);

  return {
    stop,
    isStopping: () => stopping,
    dispose() {
      finished = true;
      detach();
    },
  };
}
