import type { MailSendQueueService } from "../service/mail-send-queue.js";

const DEFAULT_SEND_QUEUE_LOOP_INTERVAL_MS = 15_000;
const DEFAULT_SEND_QUEUE_BATCH_LIMIT = 10;

export interface MailSendQueueLoopOptions {
  intervalMs?: number;
  batchLimit?: number;
}

export interface MailSendQueueLoop {
  tick(): Promise<void>;
  stop(): Promise<void>;
}

export function startMailSendQueueLoop(
  sendQueueService: MailSendQueueService,
  options: MailSendQueueLoopOptions = {},
): MailSendQueueLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_SEND_QUEUE_LOOP_INTERVAL_MS;
  const batchLimit = options.batchLimit ?? DEFAULT_SEND_QUEUE_BATCH_LIMIT;
  let stopped = false;
  let inFlight: Promise<void> | undefined;

  sendQueueService.setWorkerLoopState(true, intervalMs);

  const tick = (): Promise<void> => {
    if (stopped) {
      return inFlight ?? Promise.resolve();
    }
    if (inFlight) {
      return inFlight;
    }
    inFlight = (async () => {
      try {
        await sendQueueService.runDueBatch({ limit: batchLimit });
      } catch {
        // Worker errors are recorded on getWorkerStatus().lastErrorMessage.
      } finally {
        inFlight = undefined;
      }
    })();
    return inFlight;
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  timer.unref?.();

  return {
    tick,
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      sendQueueService.setWorkerLoopState(false, intervalMs);
      if (inFlight) {
        await inFlight;
      }
    },
  };
}
