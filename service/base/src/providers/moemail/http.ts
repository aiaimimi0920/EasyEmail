import { classifyThrownError } from "./failure.js";
import type { MoemailConfig } from "./types.js";

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

export async function requestJson(
  config: MoemailConfig,
  apiKey: string,
  method: string,
  path: string,
  options: {
    jsonBody?: Record<string, unknown>;
    cursor?: string;
  } = {},
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, config.apiBase.endsWith("/") ? config.apiBase : `${config.apiBase}/`);
  if (options.cursor?.trim()) {
    url.searchParams.set("cursor", options.cursor.trim());
  }

  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        Accept: "application/json",
        "X-API-Key": apiKey,
        ...(options.jsonBody ? { "Content-Type": "application/json" } : {}),
      },
      body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
    });

    const text = await response.text();
    if (!text) {
      return { status: response.status, body: {} };
    }

    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  } catch (error) {
    throw classifyThrownError(error);
  }
}
