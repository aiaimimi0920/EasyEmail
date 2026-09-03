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

import { execFile } from "node:child_process";

import { classifyThrownError, Mail2925ClientError } from "./failure.js";
import type { Mail2925Config, Mail2925RequestOptions } from "./types.js";

export const MAIL2925_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const PYTHON_MAIL2925_REQUEST_SCRIPT = [
  "import json, sys",
  "import requests",
  "payload = json.loads(sys.argv[1])",
  "response = requests.request(payload['method'], payload['url'], headers=payload.get('headers') or {}, params=payload.get('params') or {}, timeout=payload.get('timeout', 60))",
  "text = response.text or ''",
  "try:",
  "    body = json.loads(text) if text else {}",
  "except Exception:",
  "    body = text",
  "print(json.dumps({'status': response.status_code, 'body': body}, ensure_ascii=False))",
].join("\n");

function encodeQuery(params: Record<string, string | number | boolean | undefined>): string {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  return entries.length > 0 ? `?${entries.join("&")}` : "";
}

function encodeFormBody(body: Record<string, string | number | boolean | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  return params.toString();
}

export async function requestJson(
  config: Mail2925Config,
  method: string,
  path: string,
  options: Mail2925RequestOptions = {},
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), Math.max(5, config.timeoutSeconds) * 1000);

  try {
    const response = await fetch(
      `${config.apiBase.replace(/\/$/, "")}${path}${encodeQuery(options.query ?? {})}`,
      {
        method,
        headers: {
          Accept: "application/json, text/plain, */*",
          ...(options.formBody ? { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...(config.deviceUid ? { deviceUid: config.deviceUid } : {}),
          ...(config.cookieHeader ? { Cookie: config.cookieHeader } : {}),
          ...(options.extraHeaders ?? {}),
        },
        body: options.formBody ? encodeFormBody(options.formBody) : undefined,
        signal: controller.signal,
      },
    );

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
      throw new Mail2925ClientError(`2925 request to ${path} timed out after ${config.timeoutSeconds}s.`, "transient");
    }
    throw classifyThrownError(error);
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export async function requestJsonWithPython(
  method: string,
  url: string,
  headers: Record<string, string>,
  query: Record<string, string | number | boolean | undefined>,
  timeoutSeconds: number,
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify({
    method,
    url,
    headers,
    params: Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    ),
    timeout: Math.max(5, timeoutSeconds),
  });

  const commandCandidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];
  let lastError: Error | undefined;

  for (const command of commandCandidates) {
    try {
      const output = await new Promise<string>((resolve, reject) => {
        execFile(
          command,
          ["-c", PYTHON_MAIL2925_REQUEST_SCRIPT, payload],
          {
            maxBuffer: 4 * 1024 * 1024,
            windowsHide: true,
          },
          (error, stdout, stderr) => {
            if (error) {
              const detail = stderr?.trim() || stdout?.trim() || error.message;
              reject(new Error(detail));
              return;
            }
            resolve(stdout);
          },
        );
      });

      const normalized = output.trim();
      if (!normalized) {
        return { status: 0, body: {} };
      }
      return JSON.parse(normalized) as { status: number; body: unknown };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      const normalizedMessage = lastError.message.toLowerCase();
      if (normalizedMessage.includes("not found") || normalizedMessage.includes("cannot find")) {
        continue;
      }
      throw lastError;
    }
  }

  throw lastError ?? new Error("Python runtime is unavailable for 2925 message fallback.");
}
