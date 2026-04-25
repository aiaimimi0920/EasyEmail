import { EasyEmailError } from "../../domain/errors.js";
import type { MailAliasInfo } from "../../domain/models.js";

export interface DdgAliasClientOptions {
  apiBaseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface DdgAliasCreateResponse {
  address?: string;
}

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function extractErrorDetail(value: unknown): string | undefined {
  if (value && typeof value === "object" && Array.isArray(value) === false) {
    for (const key of ["error", "message", "detail"]) {
      const next = (value as Record<string, unknown>)[key];
      if (typeof next === "string" && next.trim()) {
        return next.trim();
      }
    }
  }

  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }

  return undefined;
}

async function decodeJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  const trimmed = text.trim();

  if (!trimmed) {
    return {};
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

export class DdgAliasClient {
  private readonly timeoutMs: number;

  private readonly apiBaseUrl: string;

  private readonly token: string;

  private readonly fetchImpl: typeof fetch;

  public constructor(options: DdgAliasClientOptions) {
    this.apiBaseUrl = normalizeApiBaseUrl(options.apiBaseUrl);
    this.token = options.token.trim();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(1000, options.timeoutMs ?? 15000);
  }

  public async createAlias(now: Date = new Date()): Promise<MailAliasInfo> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(`${this.apiBaseUrl}/api/email/addresses`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: controller.signal,
      });

      const body = await decodeJsonResponse(response);

      if (!response.ok) {
        const detail = extractErrorDetail(body);
        throw new EasyEmailError(
          "DDG_ALIAS_REQUEST_FAILED",
          `DDG alias request failed with status ${response.status}${detail ? `: ${detail}` : "."}`,
        );
      }

      const address = typeof (body as DdgAliasCreateResponse).address === "string"
        ? (body as DdgAliasCreateResponse).address?.trim()
        : "";

      if (!address) {
        throw new EasyEmailError(
          "DDG_ALIAS_INVALID_RESPONSE",
          "DDG alias response did not include an address field.",
        );
      }

      return {
        providerKey: "ddg",
        emailAddress: `${address}@duck.com`,
        createdAt: now.toISOString(),
      };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new EasyEmailError(
          "DDG_ALIAS_REQUEST_FAILED",
          `DDG alias request timed out after ${this.timeoutMs}ms.`,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function createDdgAliasClient(options: DdgAliasClientOptions): DdgAliasClient {
  return new DdgAliasClient(options);
}
