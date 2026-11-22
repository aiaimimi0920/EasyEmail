import { asRecord, readString } from "./protocol-values.js";

const AUTH_ERROR_RE = /(status 401|status 403|unauthorized|forbidden|invalid api key|invalid token|missing api key|bearer|permission)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota|capacity|insufficient balance)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;
const SHARED_DOMAIN_RESTRICTION_RE = /(shared domain.*restricted|not accepting new public addresses)/i;

export class Im215ClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "Im215ClientError";
  }
}

export function classifyIm215Error(message: string): "auth" | "capacity" | "transient" | "provider" {
  const normalized = message.trim().toLowerCase();
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

export function isSharedDomainRestrictionMessage(message: string): boolean {
  return SHARED_DOMAIN_RESTRICTION_RE.test(message);
}

export function classifyThrownError(error: unknown): Im215ClientError {
  if (error instanceof Im215ClientError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new Im215ClientError(message, classifyIm215Error(message));
}

export function buildIm215StatusError(phase: string, status: number, body: unknown): Im215ClientError {
  const detail = readString(asRecord(body).message)
    ?? readString(asRecord(body).error)
    ?? readString(asRecord(body).detail)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `215.im ${phase} failed with status ${status}.${detail ? ` ${detail}` : ""}`;
  return new Im215ClientError(message, classifyIm215Error(message), status);
}

export function parseExactEmailAddress(value: string): { address: string; localPart: string; domain: string } {
  const address = value.trim().toLowerCase();
  const atIndex = address.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === address.length - 1) {
    throw new Im215ClientError(`Invalid 215.im email address for same-address recreation: ${value}`, "provider");
  }

  return {
    address,
    localPart: address.slice(0, atIndex),
    domain: address.slice(atIndex + 1),
  };
}
