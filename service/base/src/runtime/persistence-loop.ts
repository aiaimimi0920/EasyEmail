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
  let flushInFlight: Promise<void> | null = null;
  let flushQueued = false;

  const flushOnce = async (): Promise<void> => {
    if (flushInFlight) {
      flushQueued = true;
      return flushInFlight;
    }

    flushInFlight = (async () => {
      do {
        flushQueued = false;
        const snapshot: EasyEmailSnapshot = service.getSnapshot();
        await store.saveSnapshot(snapshot);
      } while (flushQueued);
    })();

    try {
      await flushInFlight;
    } finally {
      flushInFlight = null;
    }
  };

  const intervalHandle = setInterval(() => {
    void flushOnce().catch((error) => {
      console.error("[mail-state-persistence-loop] failed to persist snapshot", error);
    });
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
