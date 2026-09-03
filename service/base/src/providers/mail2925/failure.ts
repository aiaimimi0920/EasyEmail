import { readEnvelopeCode, readEnvelopeMessage } from "./payload.js";

const AUTH_ERROR_RE = /(status 401|status 403|unauthorized|forbidden|invalid password|password error|login failed|token|登录|密码|认证)/i;
const CAPACITY_ERROR_RE = /(status 429|too many requests|rate limit|quota)/i;
const TRANSIENT_ERROR_RE = /(fetch failed|timeout|timed out|econnreset|socket hang up|network|status 5\d{2}|temporarily unavailable|gateway)/i;

export class Mail2925ClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "Mail2925ClientError";
  }
}

export function classifyMail2925Error(message: string): "auth" | "capacity" | "transient" | "provider" {
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

export function classifyThrownError(error: unknown): Mail2925ClientError {
  if (error instanceof Mail2925ClientError) {
    return error;
  }

  const message = error instanceof Error ? error.message : String(error);
  return new Mail2925ClientError(message, classifyMail2925Error(message));
}

export function buildMail2925StatusError(
  phase: string,
  status: number,
  body: unknown,
): Mail2925ClientError {
  const code = readEnvelopeCode(body);
  const detail = readEnvelopeMessage(body)
    ?? (typeof body === "string" ? body.trim() : undefined);
  const message = `2925 ${phase} failed with status ${status}${code !== undefined ? ` code ${code}` : ""}.${detail ? ` ${detail}` : ""}`;
  return new Mail2925ClientError(message, classifyMail2925Error(message), status);
}
