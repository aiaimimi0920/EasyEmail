declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import { randomBytes } from "node:crypto";
import type { ProviderInstance } from "../../domain/models.js";
import { extractOtpFromContent } from "../../domain/otp.js";
import type { DuckMailConfig } from "./client.js";

interface RequestJsonOptions {
  token?: string;
  apiKey?: string;
  jsonBody?: Record<string, unknown>;
}

export function readMetadata(instance: ProviderInstance, key: string): string | undefined {
  const value = instance.metadata[key];
  return value && value.trim() ? value.trim() : undefined;
}

export function normalizeFromContains(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : {};
}

export function asRecordList(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((item) => item && typeof item === "object") as Record<string, unknown>[]
    : [];
}

export function readStringLike(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (Array.isArray(value)) {
    const joined = value.map((item) => String(item)).join("\n").trim();
    return joined || undefined;
  }

  return undefined;
}

export function readSender(value: unknown): string | undefined {
  if (typeof value === "string") {
    const normalized = value.trim();
    return normalized || undefined;
  }

  if (value && typeof value === "object" && Array.isArray(value) === false) {
    const sender = value as Record<string, unknown>;
    const name = readStringLike(sender.name);
    const address = readStringLike(sender.address);
    const merged = [name, address].filter(Boolean).join(" ").trim();
    return merged || address || name || undefined;
  }

  return undefined;
}

export function matchesSenderFilter(sender: string | undefined, fromContains: string | undefined): boolean {
  const expected = normalizeFromContains(fromContains);
  if (!expected) {
    return true;
  }
  if (!sender) {
    return false;
  }
  return sender.toLowerCase().includes(expected);
}

export function extractOtp(values: { subject?: string; textBody?: string; htmlBody?: string }) {
  return extractOtpFromContent(values);
}

export function createAlphaNumeric(length: number): string {
  return randomBytes(Math.max(length * 2, 16))
    .toString("base64url")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, length);
}

export function createPassword(length: number): string {
  return createAlphaNumeric(Math.max(8, length || 12));
}

export function sanitizeLocalPart(value: string | undefined): string {
  const normalized = (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "");
  const withPrefix = /^[a-z]/.test(normalized) ? normalized : `d${normalized}`;
  const base = withPrefix.replace(/^[^a-z]+/, "d");
  return (base || `d${createAlphaNumeric(6).toLowerCase()}`).slice(0, 48);
}

const DOMAIN_ROTATION_OFFSETS = new Map<string, number>();

export function normalizeDomain(value: string | undefined): string | undefined {
  const normalized = value?.trim().toLowerCase();
  return normalized || undefined;
}

export function nextDomainRotationOffset(scope: string, domains: string[]): number {
  if (domains.length <= 1) {
    return 0;
  }

  const key = `${scope}:${domains.join(",")}`;
  const offset = DOMAIN_ROTATION_OFFSETS.get(key) ?? 0;
  DOMAIN_ROTATION_OFFSETS.set(key, (offset + 1) % domains.length);
  return offset;
}

export function encodeQuery(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

export function buildDuckMailStatusError(
  operation: string,
  status: number,
  body: unknown,
): Error {
  const bodyHint = readStringLike(body);
  if (status === 429) {
    return new Error(
      `DUCKMAIL_CAPACITY_FAILURE: ${operation} failed with status 429 (rate limit).${bodyHint ? ` ${bodyHint}` : ""}`,
    );
  }
  if (status >= 500 || status === 408) {
    return new Error(
      `DUCKMAIL_TRANSIENT_FAILURE: ${operation} failed with status ${status}.`,
    );
  }
  if (status === 404) {
    return new Error(
      `DUCKMAIL_MAILBOX_DELIVERY_FAILURE: ${operation} failed with status 404.`,
    );
  }
  return new Error(`DUCKMAIL_REQUEST_FAILURE: ${operation} failed with status ${status}.`);
}

export function readHydraPagePointers(body: unknown): { currentPage?: number; lastPage?: number } {
  const view = asRecord(asRecord(body)["hydra:view"]);
  const currentId = readStringLike(view["@id"]);
  const lastId = readStringLike(view["hydra:last"]);

  const parsePageFromValue = (value: string | undefined): number | undefined => {
    if (!value) {
      return undefined;
    }

    try {
      const url = value.startsWith("http://") || value.startsWith("https://")
        ? new URL(value)
        : new URL(value, "https://duckmail.local");
      const page = Number.parseInt(url.searchParams.get("page") || "", 10);
      return Number.isFinite(page) && page > 0 ? page : undefined;
    } catch {
      return undefined;
    }
  };

  return {
    currentPage: parsePageFromValue(currentId),
    lastPage: parsePageFromValue(lastId),
  };
}

export function classifyDuckMailProbeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const normalized = message.toLowerCase();
  if (normalized.includes("status 429") || normalized.includes("rate limit")) {
    return `DUCKMAIL_CAPACITY_FAILURE: ${message}`;
  }
  if (
    normalized.includes("fetch failed")
    || normalized.includes("timed out")
    || normalized.includes("timeout")
    || normalized.includes("network")
    || normalized.includes("socket hang up")
    || normalized.includes("econnreset")
    || normalized.includes("status 5")
  ) {
    return `DUCKMAIL_TRANSIENT_FAILURE: ${message}`;
  }
  return `DUCKMAIL_PROBE_FAILURE: ${message}`;
}

export async function requestJson(
  config: DuckMailConfig,
  method: string,
  path: string,
  options: RequestJsonOptions = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  const authToken = options.token || options.apiKey;
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }
  if (options.jsonBody) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${config.apiBase.replace(/\/$/, "")}${path}`, {
    method,
    headers,
    body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
  });

  const text = await response.text();
  if (!text) {
    return { status: response.status, body: {} };
  }

  try {
    return {
      status: response.status,
      body: JSON.parse(text),
    };
  } catch {
    return {
      status: response.status,
      body: text,
    };
  }
}
