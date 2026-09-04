export type MailboxFailureClass = "capacity" | "transient" | "delivery" | "auth" | "unknown";

export function trimMetadataValue(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export function normalizeDomainMetadataValue(value: string | undefined): string | undefined {
  const normalized = trimMetadataValue(value)?.toLowerCase();
  if (!normalized || normalized.includes("@")) {
    return undefined;
  }
  return normalized;
}

export function normalizeEmailMetadataValue(value: string | undefined): string | undefined {
  const normalized = trimMetadataValue(value)?.toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    return undefined;
  }
  const [localPart, domain, ...rest] = normalized.split("@");
  if (!localPart || !domain || rest.length > 0) {
    return undefined;
  }
  return `${localPart}@${domain}`;
}

export function putOptionalMetadata(
  metadata: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    metadata[key] = value;
  } else {
    delete metadata[key];
  }
}

export function putOptionalBooleanMetadata(
  metadata: Record<string, string>,
  key: string,
  value: boolean | undefined,
): void {
  if (value !== undefined) {
    metadata[key] = value ? "true" : "false";
  } else {
    delete metadata[key];
  }
}

export function putOptionalNumberMetadata(
  metadata: Record<string, string>,
  key: string,
  value: number | undefined,
): void {
  if (value !== undefined && Number.isFinite(value)) {
    metadata[key] = String(value);
  } else {
    delete metadata[key];
  }
}

export function classifyMailboxFailure(reason: string | undefined): MailboxFailureClass {
  const normalized = String(reason ?? "").trim().toLowerCase();
  if (!normalized) {
    return "unknown";
  }

  if (
    normalized.includes("status 429")
    || normalized.includes("too many requests")
    || normalized.includes("rate limit")
    || normalized.includes("quota")
    || normalized.includes("capacity")
    || normalized.includes("最大邮箱数量限制")
    || normalized.includes("已达到最大邮箱数量限制")
    || normalized.includes("maximum mailbox")
    || normalized.includes("max mailbox")
    || normalized.includes("mailbox count limit")
  ) {
    return "capacity";
  }

  if (
    normalized.includes("otp_timeout")
    || normalized.includes("code never arrived")
    || normalized.includes("mailbox")
    || normalized.includes("delivery")
  ) {
    return "delivery";
  }

  if (
    normalized.includes("unauthorized")
    || normalized.includes("forbidden")
    || normalized.includes("invalid token")
    || normalized.includes("auth")
    || normalized.includes("credential")
  ) {
    return "auth";
  }

  if (
    normalized.includes("fetch failed")
    || normalized.includes("timeout")
    || normalized.includes("timed out")
    || normalized.includes("econnreset")
    || normalized.includes("socket hang up")
    || normalized.includes("network")
    || normalized.includes("transient")
    || normalized.includes("status 5")
  ) {
    return "transient";
  }

  return "unknown";
}

export function parseConsecutiveFailureCount(value: string | undefined): number {
  const parsed = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function resolveFailureCooldownUntil(failureClass: MailboxFailureClass, now: Date): string | undefined {
  const minutes = failureClass === "capacity"
    ? 45
    : failureClass === "transient"
      ? 15
      : failureClass === "delivery"
        ? 10
        : failureClass === "auth"
          ? 90
          : 5;
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}
