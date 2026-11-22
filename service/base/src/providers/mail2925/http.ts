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

import { fetchProviderResource } from "../http-policy.js";
import { classifyThrownError, Mail2925ClientError } from "./failure.js";
import type { Mail2925Config, Mail2925RequestOptions } from "./types.js";

export const MAIL2925_BROWSER_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const PYTHON_PROCESS_TIMEOUT_GRACE_MS = 1_000;
const PYTHON_MAIL2925_REQUEST_SCRIPT = [
  "import json, sys",
  "import requests",
  "payload = json.loads(sys.stdin.read())",
  "response = requests.request(payload['method'], payload['url'], headers=payload.get('headers') or {}, params=payload.get('params') or {}, timeout=payload.get('timeout', 60), allow_redirects=False)",
  "text = response.text or ''",
  "try:",
  "    body = json.loads(text) if text else {}",
  "except Exception:",
  "    body = text",
  "print(json.dumps({'status': response.status_code, 'body': body}, ensure_ascii=False))",
].join("\n");

class PythonHelperProcessError extends Error {
  public constructor(public readonly reason: "unavailable" | "timeout" | "failed") {
    super(`2925 Python helper ${reason}.`);
    this.name = "PythonHelperProcessError";
  }
}

function sanitizePythonProcessError(error: Error): PythonHelperProcessError {
  const metadata = error as Error & { code?: string | number; killed?: boolean };
  if (metadata.code === "ENOENT") {
    return new PythonHelperProcessError("unavailable");
  }
  if (metadata.killed === true || metadata.code === "ETIMEDOUT") {
    return new PythonHelperProcessError("timeout");
  }
  return new PythonHelperProcessError("failed");
}

function parsePythonResponse(output: string): { status: number; body: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    throw new Mail2925ClientError("2925 Python request helper returned invalid JSON.", "provider");
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || !("body" in parsed)
    || !("status" in parsed)
    || typeof parsed.status !== "number"
    || !Number.isInteger(parsed.status)
    || parsed.status < 100
    || parsed.status > 599
  ) {
    throw new Mail2925ClientError("2925 Python request helper returned an invalid response.", "provider");
  }
  return { status: parsed.status, body: parsed.body };
}

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
    const response = await fetchProviderResource(
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
  const requestTimeoutSeconds = Math.max(5, timeoutSeconds);
  const payload = JSON.stringify({
    method,
    url,
    headers,
    params: Object.fromEntries(
      Object.entries(query).filter(([, value]) => value !== undefined),
    ),
    timeout: requestTimeoutSeconds,
  });

  const commandCandidates = process.platform === "win32" ? ["python", "python3"] : ["python3", "python"];

  for (const command of commandCandidates) {
    let output: string;
    try {
      output = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          command,
          ["-c", PYTHON_MAIL2925_REQUEST_SCRIPT],
          {
            killSignal: "SIGKILL",
            maxBuffer: 4 * 1024 * 1024,
            timeout: requestTimeoutSeconds * 1000 + PYTHON_PROCESS_TIMEOUT_GRACE_MS,
            windowsHide: true,
          },
          (error, stdout) => {
            if (error) {
              reject(sanitizePythonProcessError(error));
              return;
            }
            resolve(stdout);
          },
        );
        if (!child.stdin) {
          child.kill("SIGKILL");
          reject(new PythonHelperProcessError("failed"));
          return;
        }
        const rejectInputFailure = () => {
          child.kill("SIGKILL");
          reject(new PythonHelperProcessError("failed"));
        };
        child.stdin.once("error", rejectInputFailure);
        try {
          child.stdin.end(payload);
        } catch {
          rejectInputFailure();
        }
      });
    } catch (error) {
      if (error instanceof PythonHelperProcessError && error.reason === "unavailable") {
        continue;
      }
      if (error instanceof PythonHelperProcessError && error.reason === "timeout") {
        throw new Mail2925ClientError(
          `2925 Python request timed out after ${requestTimeoutSeconds}s.`,
          "transient",
        );
      }
      throw new Mail2925ClientError("2925 Python request helper failed.", "provider");
    }

    const normalized = output.trim();
    if (!normalized) {
      throw new Mail2925ClientError("2925 Python request helper returned an invalid response.", "provider");
    }
    return parsePythonResponse(normalized);
  }

  throw new Mail2925ClientError("Python runtime is unavailable for 2925 message fallback.", "provider");
}
