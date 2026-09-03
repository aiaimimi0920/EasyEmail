import type { ClassifiedMoemailFailure } from "./types.js";
import { MoemailClientError } from "./types.js";
import { asRecord, readString } from "./payload.js";

const MOEMAIL_MAX_MAILBOX_LIMIT_RE = /(已达到最大邮箱数量限制|最大邮箱数量限制|maximum mailbox|max mailbox|mailbox count limit|mailbox quantity limit)/i;
const AUTH_ERROR_RE = /(status 401|status 403|forbidden|unauthorized|api key|openapi access|permission|role)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|limit exceeded)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|gateway)/i;

export function isMailboxAlreadyUsedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.trim().toLowerCase();
  return (
    normalized.includes("status 409")
    && (
      normalized.includes("该邮箱地址已被使用")
      || normalized.includes("address already used")
      || normalized.includes("email address already used")
      || normalized.includes("already exists")
    )
  );
}

export function classifyMoemailError(message: string): MoemailClientError["kind"] {
  const normalized = message.trim().toLowerCase();
  if (MOEMAIL_MAX_MAILBOX_LIMIT_RE.test(normalized)) {
    return "capacity";
  }
  if (AUTH_ERROR_RE.test(normalized)) {
    return "auth";
  }
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

export function classifyThrownError(error: unknown): MoemailClientError {
  if (error instanceof MoemailClientError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new MoemailClientError(message, classifyMoemailError(message));
}

export function classifyMoemailFailure(error: unknown): ClassifiedMoemailFailure {
  const classified = classifyThrownError(error);
  return {
    kind: classified.kind,
    message: classified.message,
    status: classified.status,
    mailboxConflict: isMailboxAlreadyUsedError(error),
  };
}

export function buildStatusError(
  phase: string,
  status: number,
  body: unknown,
): MoemailClientError {
  const bodyRecord = asRecord(body);
  const detail = readString(bodyRecord.message)
    ?? readString(bodyRecord.error)
    ?? readString(bodyRecord.detail)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `MoEmail ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  return new MoemailClientError(message, classifyMoemailError(message), status);
}
