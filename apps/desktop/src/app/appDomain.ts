import { EasyEmailHttpError } from "../api/easyEmailHttpClient";
import { temporaryMailboxRefreshFailureMessage } from "../mail/temporaryMailboxAdapter";
import type { ErrorDto, TempRefreshDto } from "./appTypes";

export function asErrorDto(value: unknown): ErrorDto {
  if (value instanceof EasyEmailHttpError) {
    const payload =
      typeof value.payload === "object" && value.payload !== null
        ? (value.payload as Record<string, unknown>)
        : {};
    const payloadCode =
      typeof payload.code === "string"
        ? payload.code
        : typeof payload.error === "string"
          ? payload.error
          : `http_${value.status}`;
    const userMessage =
      value.status === 401
        ? "The local EasyEmail core rejected its runtime credential. Restart NMail and try again."
        : value.status === 404
          ? "The requested mailbox or message no longer exists. Refresh the mailbox list."
          : value.status >= 500
            ? `The EasyEmail core or selected provider could not complete the request: ${value.message}`
            : value.message;
    return {
      code: payloadCode,
      user_message: userMessage,
      correlation_id: "core-http",
    };
  }

  if (value instanceof Error) {
    const message = value.message.trim();
    const normalizedMessage = message.toLowerCase();
    const isTimeout = value.name === "AbortError" || normalizedMessage.includes("timed out");
    const coreExited = normalizedMessage.includes("core exited");
    const coreUnreachable =
      normalizedMessage.includes("failed to fetch") ||
      normalizedMessage.includes("networkerror") ||
      normalizedMessage.includes("network request failed");
    return {
      code: isTimeout
        ? "request_timeout"
        : coreExited
          ? "core_exited"
          : coreUnreachable
            ? "core_unreachable"
            : "request_failed",
      user_message: isTimeout
        ? "The EasyEmail core or provider timed out. Retry the mailbox action."
        : coreExited
          ? "The local EasyEmail core exited. Restart NMail and try again."
          : coreUnreachable
            ? "NMail cannot reach the local EasyEmail core. Confirm it is running and retry."
            : message || "NMail could not complete the request.",
      correlation_id: "desktop-runtime",
    };
  }

  if (typeof value === "object" && value !== null) {
    const candidate = value as Partial<ErrorDto>;
    return {
      code: typeof candidate.code === "string" ? candidate.code : "unknown_error",
      user_message:
        typeof candidate.user_message === "string"
          ? candidate.user_message
          : "NMail could not complete the request.",
      correlation_id:
        typeof candidate.correlation_id === "string" ? candidate.correlation_id : "unknown",
    };
  }

  return {
    code: "unknown_error",
    user_message: "NMail could not complete the request.",
    correlation_id: "unknown",
  };
}

export function temporaryRefreshError(result: TempRefreshDto): ErrorDto | null {
  const message = temporaryMailboxRefreshFailureMessage(result);
  return message
    ? {
        code: "MAILBOX_REFRESH_PARTIAL_FAILURE",
        user_message: message,
        correlation_id: "core-http-refresh",
      }
    : null;
}

export function optionalValue(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function mergeByIdentity<T>(
  preferred: T[],
  existing: T[],
  identity: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  return [...preferred, ...existing].filter((value) => {
    const key = identity(value);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isQqMailAddress(value: string): boolean {
  return value.trim().toLowerCase().endsWith("@qq.com");
}
