export interface ExtractionItem {
  messageId: string; receivedAt: number; otp: { code: string } | null; links: { url: string }[];
}
export interface ExtractionResult {
  items: ExtractionItem[]; searched: number; searchLimited: boolean;
  sync: { nextPage: number | null; complete?: boolean; missing?: number };
}
export interface ExtractionCheck extends ExtractionResult {
  state: "waiting" | "matched"; retryAfterSeconds: number | null;
}
interface Clock { now(): number; sleep(ms: number, signal: AbortSignal): Promise<void> }
export const EXTRACTION_WAIT = { milliseconds: 60000, attempts: 12, interval: 5000 } as const;

function pause(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForExtractions(
  check: (page: number, signal: AbortSignal) => Promise<ExtractionCheck>,
  signal: AbortSignal,
  onCheck: (result: ExtractionCheck, attempt: number) => void,
  clock: Clock = { now: () => performance.now(), sleep: pause },
): Promise<{ state: "matched" | "exhausted"; attempts: number; result: ExtractionCheck | null }> {
  const started = clock.now(), deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException("Extraction wait deadline", "TimeoutError")), EXTRACTION_WAIT.milliseconds);
  const combined = AbortSignal.any([signal, deadline.signal]);
  let attempts = 0, page = 1, result: ExtractionCheck | null = null;
  const exhausted = () => ({ state: "exhausted" as const, attempts, result });
  try {
    while (attempts < EXTRACTION_WAIT.attempts && clock.now() - started < EXTRACTION_WAIT.milliseconds) {
      combined.throwIfAborted();
      attempts++;
      const next = await check(page, combined);
      combined.throwIfAborted();
      if (clock.now() - started >= EXTRACTION_WAIT.milliseconds) return exhausted();
      result = next;
      onCheck(result, attempts);
      if (result.state === "matched") return { state: "matched", attempts, result };
      if (attempts === EXTRACTION_WAIT.attempts) break;
      page = result.sync.nextPage ?? 1;
      const remaining = EXTRACTION_WAIT.milliseconds - (clock.now() - started);
      if (remaining <= EXTRACTION_WAIT.interval) break;
      await clock.sleep(EXTRACTION_WAIT.interval, combined);
    }
    return exhausted();
  } catch (error) {
    signal.throwIfAborted();
    if (deadline.signal.aborted) return exhausted();
    throw error;
  } finally { clearTimeout(timer); }
}
