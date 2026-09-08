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

import type { CloudflareTempEmailConfig } from "./models.js";
import { fetchProviderResourceWithRecovery } from "../../http-policy.js";
import { asRecord } from "./mail-content.js";

export async function requestJson(
  config: CloudflareTempEmailConfig,
  method: string,
  path: string,
  options: {
    bearerToken?: string;
    jsonBody?: Record<string, unknown>;
    limit?: number;
    offset?: number;
  } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  const separator = path.includes("?") ? "&" : "?";
  const withQuery = typeof options.limit === "number"
    ? `${path}${separator}limit=${encodeURIComponent(String(options.limit))}&offset=${encodeURIComponent(String(options.offset ?? 0))}`
    : path;
  const controller = new AbortController();
  const timeoutMs = Math.max(1000, config.timeoutSeconds * 1000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchProviderResourceWithRecovery(
      `${config.baseUrl.replace(/\/$/, "")}${withQuery}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(config.customAuth ? { "x-custom-auth": config.customAuth } : {}),
          ...(options.bearerToken ? { Authorization: `Bearer ${options.bearerToken}` } : {}),
          ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
        },
        body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
        signal: controller.signal,
      },
    );

    const text = await response.text();
    const trimmed = text.trim();
    const parsedBody = (() => {
      if (!trimmed) {
        return {};
      }

      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return trimmed;
      }

      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return trimmed;
      }
    })();

    return {
      status: response.status,
      body: parsedBody,
      rawText: text,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Cloudflare Temp Email request timed out after ${config.timeoutSeconds}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestAdminJson(
  config: CloudflareTempEmailConfig,
  method: string,
  path: string,
  options: {
    jsonBody?: Record<string, unknown>;
  } = {},
): Promise<{ status: number; body: unknown; rawText: string }> {
  if (!config.adminAuth?.trim()) {
    throw new Error("Cloudflare Temp Email adminAuth is not configured.");
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, config.timeoutSeconds * 1000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchProviderResourceWithRecovery(
      `${config.baseUrl.replace(/\/$/, "")}${path}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(config.customAuth ? { "x-custom-auth": config.customAuth } : {}),
          "x-admin-auth": config.adminAuth,
          ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
        },
        body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
        signal: controller.signal,
      },
    );

    const text = await response.text();
    const trimmed = text.trim();
    const parsedBody = (() => {
      if (!trimmed) {
        return {};
      }

      if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
        return trimmed;
      }

      try {
        return JSON.parse(trimmed) as unknown;
      } catch {
        return trimmed;
      }
    })();

    return {
      status: response.status,
      body: parsedBody,
      rawText: text,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Cloudflare Temp Email admin request timed out after ${config.timeoutSeconds}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function extractErrorDetail(body: unknown, rawText?: string): string | undefined {
  if (typeof body === "string") {
    return body.trim() || undefined;
  }

  const record = asRecord(body);
  for (const key of ["error", "message", "detail", "msg"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return rawText?.trim() || undefined;
}
