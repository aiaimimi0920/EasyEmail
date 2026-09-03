import { CAPACITY_ERROR_RE, TRANSIENT_ERROR_RE } from "./constants.js";
import { readStringLike } from "./metadata.js";
import { asRecord } from "./payload.js";

function readErrorCode(body: unknown): string | undefined {
  return readStringLike(asRecord(body).error)?.toLowerCase();
}

function readErrorReason(body: unknown): string | undefined {
  return readStringLike(asRecord(body).reason);
}

export function hasM2uBodyError(body: unknown): boolean {
  return Boolean(readErrorCode(body));
}

export function classifyM2uError(message: string): "transient" | "capacity" | "provider" {
  const normalized = message.trim().toLowerCase();
  if (CAPACITY_ERROR_RE.test(normalized)) {
    return "capacity";
  }
  if (TRANSIENT_ERROR_RE.test(normalized)) {
    return "transient";
  }
  return "provider";
}

export function classifyM2uResponse(status: number, body: unknown, phase: string): "transient" | "capacity" | "provider" {
  if (hasM2uBodyError(body)) {
    return classifyM2uError(formatM2uError(phase, status, body).message);
  }
  return classifyM2uError(`status ${status}`);
}

export function formatM2uError(phase: string, status: number, body: unknown): Error {
  const errorCode = readErrorCode(body);
  const reason = readErrorReason(body);
  const detailParts = [
    errorCode ? `error=${errorCode}` : undefined,
    reason ? `reason=${reason}` : undefined,
  ].filter((item): item is string => Boolean(item));
  const rawMessage = `M2U ${phase} failed with status ${status}${detailParts.length > 0 ? ` (${detailParts.join(", ")})` : ""}.`;
  const category = classifyM2uError(rawMessage);
  if (category === "capacity") {
    return new Error(`M2U_CAPACITY_FAILURE: ${rawMessage}`);
  }
  if (category === "transient") {
    return new Error(`M2U_TRANSIENT_FAILURE: ${rawMessage}`);
  }
  return new Error(`M2U_PROVIDER_FAILURE: ${rawMessage}`);
}
