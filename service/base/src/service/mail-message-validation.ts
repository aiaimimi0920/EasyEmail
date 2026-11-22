import { Buffer } from "node:buffer";

import { EasyEmailError } from "../domain/errors.js";
import type {
  MailMessageDetailScope,
  MailMessageFlagName,
  MailMessageListPosition,
  MailMessageListScope,
  MailMessageSummary,
  MailVerificationAccountScope,
} from "../domain/mail-message.js";

export const DEFAULT_MAIL_MESSAGE_PAGE_SIZE = 100;
export const MAX_MAIL_MESSAGE_PAGE_SIZE = 500;
export const DEFAULT_VERIFICATION_PAGE_SIZE = 50;
export const MAX_VERIFICATION_PAGE_SIZE = 100;
export const MAX_MAIL_BODY_CHARS = 512_000;

export const DRAFT_SAVE_FIELDS = new Set([
  "draftId",
  "accountId",
  "targetAddress",
  "ccAddresses",
  "bccAddresses",
  "subject",
  "bodyText",
  "bodyHtml",
]);

export const SET_FLAG_FIELDS = new Set(["flagName", "enabled"]);
export const SET_FOLDER_FIELDS = new Set(["folderName"]);
export const SET_LABEL_FIELDS = new Set(["labelName", "enabled"]);
export const EMPTY_TRASH_FIELDS = new Set(["messageIds"]);

interface MailMessageCursorPayload extends MailMessageListPosition {
  scope: MailMessageListScope;
  accountId: string | null;
  sessionId: string | null;
  folder: string | null;
  label: string | null;
  search: string | null;
  includeArchived: boolean;
}

export function assertPlainObject(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${label} request must be an object.`);
  }
}

export function assertKnownMailMessageFields(
  input: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", `Unsupported ${label} field: ${key}.`);
    }
  }
}

export function normalizeMailMessageId(rawId: unknown, fieldName = "messageId"): string {
  if (typeof rawId !== "string") {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${fieldName} must be a non-empty string.`);
  }
  const normalized = rawId.trim();
  if (!normalized || normalized.length > 256) {
    throw new EasyEmailError(
      "INVALID_MAIL_MESSAGE",
      `${fieldName} must be between 1 and 256 characters.`,
    );
  }
  return normalized;
}

export function normalizeMailMessageListScope(rawScope: unknown): MailMessageListScope {
  if (rawScope === undefined || rawScope === "") {
    return "all";
  }
  if (
    rawScope === "all"
    || rawScope === "anonymous"
    || rawScope === "normal_account"
    || rawScope === "promoted_account"
    || rawScope === "agent_account"
  ) {
    return rawScope;
  }
  throw new EasyEmailError(
    "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
    "Mail message scope is unsupported.",
  );
}

export function normalizeMailMessageDetailScope(rawScope: unknown): MailMessageDetailScope {
  if (rawScope === undefined || rawScope === "") {
    return "normal";
  }
  if (rawScope === "normal" || rawScope === "agent" || rawScope === "all") {
    return rawScope;
  }
  throw new EasyEmailError(
    "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
    "Mail message detail scope is unsupported.",
  );
}

export function normalizeVerificationScope(
  rawScope: unknown,
): MailVerificationAccountScope | "all" {
  if (rawScope === undefined || rawScope === "") {
    return "all";
  }
  if (
    rawScope === "all"
    || rawScope === "anonymous"
    || rawScope === "normal"
    || rawScope === "promoted"
    || rawScope === "agent"
  ) {
    return rawScope;
  }
  throw new EasyEmailError(
    "MAIL_MESSAGE_SCOPE_UNSUPPORTED",
    "Verification scope is unsupported.",
  );
}

export function normalizeMailMessageFlagName(rawFlag: unknown): MailMessageFlagName {
  if (
    rawFlag === "read"
    || rawFlag === "starred"
    || rawFlag === "archived"
    || rawFlag === "important"
  ) {
    return rawFlag;
  }
  throw new EasyEmailError(
    "MAIL_MESSAGE_FLAG_UNSUPPORTED",
    "Local message flag must be read, starred, archived, or important.",
  );
}

export function normalizeMailFolderName(rawFolder: unknown): string {
  if (typeof rawFolder !== "string") {
    throw new EasyEmailError(
      "MAIL_MESSAGE_FOLDER_UNSUPPORTED",
      "Folder name must be a non-empty string.",
    );
  }
  const normalized = rawFolder.trim().toLowerCase();
  if (!normalized || Array.from(normalized).length > 64) {
    throw new EasyEmailError(
      "MAIL_MESSAGE_FOLDER_UNSUPPORTED",
      "Folder name must contain from 1 to 64 characters.",
    );
  }
  return normalized;
}

export function normalizeMailLabelName(rawLabel: unknown): string {
  if (typeof rawLabel !== "string") {
    throw new EasyEmailError(
      "MAIL_MESSAGE_LABEL_INVALID",
      "Label name must be a non-empty string.",
    );
  }
  const normalized = rawLabel.trim();
  if (!normalized || Array.from(normalized).length > 32) {
    throw new EasyEmailError(
      "MAIL_MESSAGE_LABEL_INVALID",
      "Label name must contain from 1 to 32 characters.",
    );
  }
  return normalized;
}

export function normalizeRequiredBoolean(rawValue: unknown, fieldName: string): boolean {
  if (typeof rawValue !== "boolean") {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${fieldName} must be a boolean.`);
  }
  return rawValue;
}

export function normalizeDraftAddressList(rawList: unknown, fieldName: string): string[] {
  if (rawList === undefined) {
    return [];
  }
  if (!Array.isArray(rawList) || rawList.length > 100) {
    throw new EasyEmailError(
      "INVALID_MAIL_MESSAGE",
      `${fieldName} must be an array of at most 100 addresses.`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const item of rawList) {
    if (typeof item !== "string") {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${fieldName} entries must be strings.`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    if (trimmed.length > 320) {
      throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${fieldName} address is too long.`);
    }
    const key = trimmed.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export function normalizeOptionalDraftText(
  rawValue: unknown,
  fieldName: string,
  maxLength: number,
): string {
  if (rawValue === undefined || rawValue === null) {
    return "";
  }
  if (typeof rawValue !== "string") {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE", `${fieldName} must be a string.`);
  }
  if (rawValue.length > maxLength) {
    throw new EasyEmailError(
      "INVALID_MAIL_MESSAGE",
      `${fieldName} exceeds maximum length of ${maxLength} characters.`,
    );
  }
  return rawValue;
}

export function encodeMailMessageCursor(
  lastItem: MailMessageSummary,
  binding: Omit<MailMessageCursorPayload, "observedAt" | "id">,
): string {
  const payload: MailMessageCursorPayload = {
    ...binding,
    observedAt: lastItem.observedAt,
    id: lastItem.id,
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

export function decodeMailMessageCursor(
  cursor: string,
  expected: Omit<MailMessageCursorPayload, "observedAt" | "id">,
): MailMessageListPosition {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid cursor");
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.scope !== expected.scope
      || record.accountId !== expected.accountId
      || record.sessionId !== expected.sessionId
      || record.folder !== expected.folder
      || record.label !== expected.label
      || record.search !== expected.search
      || record.includeArchived !== expected.includeArchived
      || typeof record.observedAt !== "string"
      || !record.observedAt
      || typeof record.id !== "string"
      || !record.id
    ) {
      throw new Error("cursor mismatch");
    }
    return {
      observedAt: record.observedAt,
      id: record.id,
    };
  } catch {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE_CURSOR", "Mail message cursor is invalid.");
  }
}
