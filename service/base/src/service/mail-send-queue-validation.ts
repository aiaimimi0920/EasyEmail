import { createHash } from "node:crypto";

import { EasyEmailError } from "../domain/errors.js";
import type {
  MailSendEnqueueInput,
  MailSendQueueItem,
  MailSendQueueListPosition,
  MailSendQueueStatus,
} from "../domain/mail-send-queue.js";
import { assertNoRawSecretFields, assertOnlyKnownFields } from "./account-validation.js";
import { extractEnvelopeEmailAddress } from "./smtp-mime-encoder.js";

export const DEFAULT_SEND_QUEUE_PAGE_SIZE = 25;
export const MAX_SEND_QUEUE_PAGE_SIZE = 100;
export const DEFAULT_SEND_QUEUE_DUE_BATCH_LIMIT = 10;
export const MAX_SEND_QUEUE_DUE_BATCH_LIMIT = 100;

export const SEND_ENQUEUE_FIELDS = new Set([
  "accountId",
  "targetAddress",
  "ccAddresses",
  "bccAddresses",
  "scheduledAt",
  "subject",
  "bodyText",
  "bodyHtml",
  "idempotencyKey",
]);
export const SEND_CANCEL_FIELDS = new Set(["expectedVersion"]);
export const SEND_RETRY_FIELDS = new Set(["expectedVersion", "confirmDeliveryUnknown"]);
export const SEND_RUN_BATCH_FIELDS = new Set(["limit"]);

const ALLOWED_QUEUE_STATUSES = new Set<MailSendQueueStatus>([
  "queued",
  "sending",
  "sent",
  "auth_failed",
  "delivery_unknown",
  "cancelled",
  "failed",
]);

export function assertReplySenderIdentityLocked(
  accountId: string,
  lockedReplyAccountId: string | null | undefined,
): void {
  const locked = typeof lockedReplyAccountId === "string" ? lockedReplyAccountId.trim() : "";
  if (locked && locked !== accountId.trim()) {
    throw new EasyEmailError(
      "ERR_IDENTITY_LOCKED",
      "Reply or forward sender identity is locked to the original receiving account.",
    );
  }
}

export function normalizeSendQueueStatus(value: unknown): MailSendQueueStatus {
  if (typeof value !== "string" || !ALLOWED_QUEUE_STATUSES.has(value as MailSendQueueStatus)) {
    throw new EasyEmailError("INVALID_QUERY", "Invalid send queue status filter.");
  }
  return value as MailSendQueueStatus;
}

export function normalizeRecipientArray(values: unknown, fieldName: string): string[] {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > 100) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", `${fieldName} must be an array of at most 100 addresses.`);
  }
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of values) {
    if (typeof raw !== "string") {
      throw new EasyEmailError("INVALID_SEND_MESSAGE", `${fieldName} entries must be strings.`);
    }
    for (const part of raw.split(/[,\s;]+/u).map((s) => s.trim()).filter(Boolean)) {
      const email = extractEnvelopeEmailAddress(part, fieldName);
      if (!seen.has(email)) {
        seen.add(email);
        normalized.push(email);
      }
    }
  }
  return normalized;
}

export function normalizeScheduledAt(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new EasyEmailError("INVALID_SEND_SCHEDULE", "scheduledAt must be an ISO-8601 string or null.");
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new EasyEmailError("INVALID_SEND_SCHEDULE", "Choose a valid scheduled send time.");
  }
  return new Date(parsed).toISOString();
}

export function normalizeIdempotencyKey(
  bodyValue: unknown,
  headerValue: string | undefined,
): string | undefined {
  const candidate = headerValue?.trim() || (typeof bodyValue === "string" ? bodyValue.trim() : "");
  if (bodyValue !== undefined && bodyValue !== null && typeof bodyValue !== "string") {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "idempotencyKey must be a string.");
  }
  if (
    headerValue?.trim()
    && typeof bodyValue === "string"
    && bodyValue.trim()
    && headerValue.trim() !== bodyValue.trim()
  ) {
    throw new EasyEmailError(
      "INVALID_SEND_MESSAGE",
      "Idempotency-Key header and body idempotencyKey must match when both are provided.",
    );
  }
  if (!candidate) return undefined;
  if (candidate.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(candidate)) {
    throw new EasyEmailError(
      "INVALID_SEND_MESSAGE",
      "Idempotency-Key must contain 1 to 256 safe ASCII identifier characters.",
    );
  }
  return candidate;
}

export function normalizeEnqueueInput(
  input: MailSendEnqueueInput,
  headerIdempotencyKey?: string,
): {
  accountId: string;
  toAddresses: string[];
  targetAddress: string;
  ccAddresses: string[];
  bccAddresses: string[];
  scheduledAt?: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  idempotencyKey?: string;
  payloadFingerprint: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "Send request must be an object.");
  }
  assertNoRawSecretFields(input);
  assertOnlyKnownFields(input as unknown as Record<string, unknown>, SEND_ENQUEUE_FIELDS, "Send request");

  const accountId = typeof input.accountId === "string" ? input.accountId.trim() : "";
  const rawTarget = typeof input.targetAddress === "string" ? input.targetAddress : "";
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  if (typeof input.bodyText !== "string" || input.bodyText.length > 2 * 1024 * 1024) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "bodyText must be a string up to 2 MiB.");
  }
  if (
    input.bodyHtml !== undefined
    && input.bodyHtml !== null
    && (typeof input.bodyHtml !== "string" || input.bodyHtml.length > 4 * 1024 * 1024)
  ) {
    throw new EasyEmailError("INVALID_SEND_MESSAGE", "bodyHtml must be a string up to 4 MiB.");
  }
  const toAddresses = normalizeRecipientArray([rawTarget], "targetAddress");
  if (!accountId || toAddresses.length === 0 || !subject || subject.length > 998) {
    throw new EasyEmailError(
      "INVALID_SEND_MESSAGE",
      "Select a sender account and enter a valid target address and subject.",
    );
  }
  const ccAddresses = normalizeRecipientArray(input.ccAddresses, "ccAddresses");
  const bccAddresses = normalizeRecipientArray(input.bccAddresses, "bccAddresses");
  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey, headerIdempotencyKey);
  const targetAddress = toAddresses.join(", ");
  const bodyHtml = typeof input.bodyHtml === "string" && input.bodyHtml.trim() ? input.bodyHtml : undefined;

  const payloadFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        accountId,
        targetAddress,
        ccAddresses,
        bccAddresses,
        scheduledAt: scheduledAt ?? null,
        subject,
        bodyText: input.bodyText,
        bodyHtml: bodyHtml ?? null,
      }),
      "utf8",
    )
    .digest("hex");

  return {
    accountId,
    toAddresses,
    targetAddress,
    ccAddresses,
    bccAddresses,
    scheduledAt,
    subject,
    bodyText: input.bodyText,
    bodyHtml,
    idempotencyKey,
    payloadFingerprint,
  };
}

export function encodeSendQueueCursor(
  item: MailSendQueueItem,
  accountId: string | undefined,
  status: MailSendQueueStatus | undefined,
): string {
  const position: MailSendQueueListPosition = {
    filterAccountId: accountId ?? "",
    filterStatus: status ?? "all",
    createdAt: item.createdAt,
    id: item.id,
  };
  return Buffer.from(JSON.stringify(position), "utf8").toString("base64url");
}

export function decodeSendQueueCursor(
  cursor: string,
  expectedAccountId: string | undefined,
  expectedStatus: MailSendQueueStatus | undefined,
): MailSendQueueListPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (
      !parsed
      || typeof parsed !== "object"
      || parsed.filterAccountId !== (expectedAccountId ?? "")
      || parsed.filterStatus !== (expectedStatus ?? "all")
      || typeof parsed.createdAt !== "string"
      || Number.isNaN(Date.parse(parsed.createdAt))
      || typeof parsed.id !== "string"
      || !parsed.id
    ) {
      throw new Error("invalid cursor");
    }
    return {
      filterAccountId: parsed.filterAccountId,
      filterStatus: parsed.filterStatus as MailSendQueueStatus | "all",
      createdAt: parsed.createdAt,
      id: parsed.id,
    };
  } catch {
    throw new EasyEmailError("INVALID_SEND_QUEUE_CURSOR", "Send queue cursor is invalid.");
  }
}
