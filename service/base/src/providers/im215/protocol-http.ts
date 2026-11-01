declare const fetch: (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

import type { Im215Config } from "./protocol-config.js";
import { classifyThrownError, Im215ClientError } from "./protocol-errors.js";
import { encodeQuery } from "./protocol-values.js";
import { fetchProviderResource } from "../http-policy.js";

interface Im215RequestOptions {
  query?: Record<string, string | number | undefined>;
  jsonBody?: Record<string, unknown>;
}

export async function requestJson(
  config: Im215Config,
  apiKey: string,
  method: string,
  path: string,
  options: Im215RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(5, config.timeoutSeconds) * 1000);
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${apiKey}`,
  };
  if (options.jsonBody) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const response = await fetchProviderResource(`${config.apiBase.replace(/\/$/, "")}${path}${encodeQuery(options.query ?? {})}`, {
      method,
      headers,
      body: options.jsonBody ? JSON.stringify(options.jsonBody) : undefined,
      signal: controller.signal,
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
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("abort")) {
      throw new Im215ClientError(`215.im request to ${path} timed out after ${config.timeoutSeconds}s.`, "transient");
    }
    throw classifyThrownError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}
