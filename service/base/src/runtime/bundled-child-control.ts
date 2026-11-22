import { timingSafeEqual } from "node:crypto";
import type { EventEmitter } from "node:events";
import { writeSync } from "node:fs";

export type BundledControlEnvironment = Readonly<Record<string, string | undefined>>;

export const BUNDLED_CHILD_CONTROL_PROTOCOL_VERSION = 1;
const MAX_CONTROL_LINE_BYTES = 4096;

export interface BundledShutdownController {
  stop(): Promise<void>;
  isStopping(): boolean;
}

export interface ControlReadableStream extends EventEmitter {
  resume?: () => unknown;
  pause?: () => unknown;
}

export interface BundledChildControlOptions {
  env?: BundledControlEnvironment;
  input?: ControlReadableStream;
  report?: (event: string) => void;
}

export interface InstalledBundledChildControl {
  readonly enabled: boolean;
  dispose(): void;
}

export function isBundledChildModeEnabled(
  env: BundledControlEnvironment = process.env,
): boolean {
  return env.EASY_EMAIL_BUNDLED_CHILD_MODE?.trim() === "1";
}

function constantTimeStringEqual(left: string, right: string): boolean {
  const leftBuf = Buffer.from(left, "utf8");
  const rightBuf = Buffer.from(right, "utf8");
  if (leftBuf.byteLength !== rightBuf.byteLength) {
    return false;
  }
  return timingSafeEqual(leftBuf, rightBuf);
}

export function installBundledChildControl(
  shutdown: BundledShutdownController,
  options: BundledChildControlOptions = {},
): InstalledBundledChildControl {
  const env = options.env ?? process.env;
  if (!isBundledChildModeEnabled(env)) {
    return {
      enabled: false,
      dispose() {},
    };
  }

  const input = options.input ?? (process.stdin as unknown as ControlReadableStream);
  const report = options.report ?? ((event: string) => {
    writeSync(2, `${event}\n`);
  });
  const expectedToken = env.EASY_EMAIL_BUNDLED_CONTROL_TOKEN?.trim() || undefined;

  let disposed = false;
  let triggered = false;
  let discardingOversizedLine = false;
  let lineBuffer = "";

  const safeReport = (event: string) => {
    try {
      report(event);
    } catch {
      // Never allow closed stdio pipes to disrupt bounded shutdown.
    }
  };

  const detach = () => {
    if (disposed) return;
    disposed = true;
    input.off("data", onData);
    input.off("end", onParentEof);
    input.off("close", onParentEof);
    input.off("error", onStreamError);
    input.pause?.();
  };

  const triggerShutdown = (reason: "command" | "parent_eof") => {
    if (triggered || disposed) return;
    triggered = true;
    detach();
    safeReport(`[easy_email] bundled_control_shutdown reason=${reason}`);
    void shutdown.stop();
  };

  const handleLine = (rawLine: string) => {
    const trimmed = rawLine.trim();
    if (!trimmed || triggered || disposed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      safeReport("easy_email_control_message_invalid");
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      safeReport("easy_email_control_message_invalid");
      return;
    }

    const record = parsed as Record<string, unknown>;
    if (
      record.protocolVersion !== BUNDLED_CHILD_CONTROL_PROTOCOL_VERSION
      || record.command !== "shutdown"
    ) {
      safeReport("easy_email_control_message_invalid");
      return;
    }

    if (expectedToken !== undefined) {
      const providedToken = typeof record.controlToken === "string" ? record.controlToken : "";
      if (!providedToken || !constantTimeStringEqual(providedToken, expectedToken)) {
        safeReport("easy_email_control_unauthorized");
        return;
      }
    }

    triggerShutdown("command");
  };

  function onData(chunk: Buffer | string) {
    if (disposed || triggered) return;
    const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let offset = 0;

    while (offset < text.length && !triggered && !disposed) {
      const newlineIndex = text.indexOf("\n", offset);
      if (discardingOversizedLine) {
        if (newlineIndex === -1) {
          return;
        }
        discardingOversizedLine = false;
        lineBuffer = "";
        offset = newlineIndex + 1;
        continue;
      }

      if (newlineIndex === -1) {
        lineBuffer += text.slice(offset);
        if (Buffer.byteLength(lineBuffer, "utf8") > MAX_CONTROL_LINE_BYTES) {
          lineBuffer = "";
          discardingOversizedLine = true;
          safeReport("easy_email_control_frame_too_large");
        }
        return;
      }

      const candidate = lineBuffer + text.slice(offset, newlineIndex);
      lineBuffer = "";
      offset = newlineIndex + 1;

      if (Buffer.byteLength(candidate, "utf8") > MAX_CONTROL_LINE_BYTES) {
        safeReport("easy_email_control_frame_too_large");
        continue;
      }
      handleLine(candidate);
    }
  }

  function onParentEof() {
    if (disposed || triggered || shutdown.isStopping()) return;
    triggerShutdown("parent_eof");
  }

  function onStreamError() {
    if (disposed || triggered || shutdown.isStopping()) return;
    triggerShutdown("parent_eof");
  }

  input.on("data", onData);
  input.on("end", onParentEof);
  input.on("close", onParentEof);
  input.on("error", onStreamError);
  input.resume?.();

  return {
    enabled: true,
    dispose: detach,
  };
}
