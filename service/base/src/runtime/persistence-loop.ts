import type { EasyEmailService } from "../service/easy-email-service.js";
import type { EasyEmailSnapshot } from "../domain/models.js";
import type { MailStateStore } from "../persistence/contracts.js";

export interface MailStatePersistenceLoop {
  intervalMs: number;
  flush(): Promise<void>;
  stop(): Promise<void>;
}

export interface MailStatePersistenceLoopOptions {
  intervalMs: number;
}

export function startMailStatePersistenceLoop(
  service: EasyEmailService,
  store: MailStateStore,
  options: MailStatePersistenceLoopOptions,
): MailStatePersistenceLoop {
  const flushOnce = async (): Promise<void> => {
    const snapshot: EasyEmailSnapshot = service.getSnapshot();
    await store.saveSnapshot(snapshot);
  };

  const intervalHandle = setInterval(() => {
    void flushOnce().catch(() => undefined);
  }, options.intervalMs);

  return {
    intervalMs: options.intervalMs,
    flush() {
      return flushOnce();
    },
    async stop() {
      clearInterval(intervalHandle);
      await flushOnce();
    },
  };
}

