import { Buffer } from "node:buffer";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EasyEmailError } from "../domain/errors.js";
import { EASY_EMAIL_HTTP_ROUTES } from "./contracts.js";
import { EasyEmailHttpHandler } from "./handler.js";
import { resolveEasyEmailHttpErrorStatus } from "./error-status.js";
import { reportHttpFailure } from "./failure-diagnostic.js";
import { handleAdminRoute } from "./routes/admin.js";
import { handleAgentMailRoute } from "./routes/agent-mail.js";
import { handleAvatarMailRoute } from "./routes/avatars.js";
import { handleExtensionsRoute } from "./routes/extensions.js";
import { handleImapSyncRoute } from "./routes/imap-sync.js";
import { handleInternalRoute } from "./routes/internal.js";
import { handleMessageRoute } from "./routes/messages.js";
import { handleOmnimailWorkbenchRoute } from "./routes/omnimail-workbench.js";
import { handlePublicRoute } from "./routes/public.js";
import { handleSendQueueRoute } from "./routes/send-queue.js";

export interface EasyEmailHttpServerOptions {
  hostname?: string;
  port?: number;
  apiKey?: string;
  corsOrigins?: readonly string[];
  maxRequestBodyBytes?: number;
  bundledInstanceNonce?: string;
}

export interface StartedEasyEmailHttpServer {
  baseUrl: string;
  hostname: string;
  port: number;
  close(): Promise<void>;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(value);
}

const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024;

function requestBodyTooLarge(): EasyEmailError {
  return new EasyEmailError(
    "REQUEST_BODY_TOO_LARGE",
    "Request body exceeds the configured size limit.",
  );
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const declaredLength = request.headers["content-length"];
    if (typeof declaredLength === "string" && Number(declaredLength) > maxBytes) {
      request.resume();
      reject(requestBodyTooLarge());
      return;
    }

    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let exceeded = false;
    request.on("data", (chunk: string | Uint8Array) => {
      if (exceeded) return;
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxBytes) {
        exceeded = true;
        chunks.length = 0;
        reject(requestBodyTooLarge());
        return;
      }
      chunks.push(buffer);
    });
    request.on("end", () => {
      if (!exceeded) resolve(Buffer.concat(chunks, receivedBytes).toString("utf8"));
    });
    request.on("error", (error) => {
      if (!exceeded) reject(error);
    });
  });
}

async function readJsonBody<T>(request: IncomingMessage, maxBytes: number): Promise<T> {
  const body = await readBody(request, maxBytes);
  try {
    return (body ? JSON.parse(body) : {}) as T;
  } catch {
    throw new EasyEmailError("INVALID_JSON", "Request body is not valid JSON.");
  }
}

function writeJson(response: ServerResponse, statusCode: number, value: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(encodeJson(value));
}

function writeEasyEmailError(response: ServerResponse, statusCode: number, error: EasyEmailError): void {
  writeJson(response, statusCode, {
    code: error.code,
    ...error.details,
    error: error.message,
    message: error.message,
  });
}

function appendVaryHeader(response: ServerResponse, value: string): void {
  const current = response.getHeader("vary");
  const values = Array.isArray(current)
    ? current
    : typeof current === "string"
      ? current.split(",")
      : [];
  if (!values.some((entry) => entry.trim().toLowerCase() === value.toLowerCase())) {
    response.setHeader("vary", [...values, value].join(", "));
  }
}

function checkApiKey(apiKey: string | undefined, request: IncomingMessage, response: ServerResponse): boolean {
  if (!apiKey) return true;
  if (request.headers.authorization === `Bearer ${apiKey}`) return true;

  writeJson(response, 401, {
    error: "UNAUTHORIZED",
    message: "A valid Bearer token is required. Set Authorization: Bearer <api-key>.",
  });
  return false;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1") {
    return true;
  }
  const octets = normalized.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function extractVerificationCodeSessionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/mailboxes\/([^/]+)\/code$/);
  return matched?.[1] ? decodeURIComponent(matched[1]) : undefined;
}

function extractAuthenticationLinkSessionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/mailboxes\/([^/]+)\/auth-link$/);
  return matched?.[1] ? decodeURIComponent(matched[1]) : undefined;
}

function extractMailboxRefreshSessionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/mailboxes\/([^/]+)\/refresh$/);
  return matched?.[1] ? decodeURIComponent(matched[1]) : undefined;
}

function extractProviderProbeInstanceId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/providers\/([^/]+)\/probe$/);
  return matched?.[1] ? decodeURIComponent(matched[1]) : undefined;
}

function extractObservedMessageId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/query\/observed-messages\/([^/]+)$/);
  return matched?.[1] ? decodeURIComponent(matched[1]) : undefined;
}

function parseQueryString(url: string): Record<string, string> {
  const queryText = url.split("?")[1];
  const entries: Record<string, string> = {};
  if (!queryText) {
    return entries;
  }

  for (const part of queryText.split("&")) {
    if (!part) continue;
    const [rawKey, rawValue = ""] = part.split("=");
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, "%20"));
      value = decodeURIComponent(rawValue.replace(/\+/g, "%20"));
    } catch {
      throw new EasyEmailError(
        "INVALID_QUERY",
        "Request query string contains invalid percent-encoding.",
      );
    }
    entries[key] = value;
  }

  return entries;
}

export function createEasyEmailHttpServer(
  handler: EasyEmailHttpHandler,
  options: EasyEmailHttpServerOptions = {},
): Promise<StartedEasyEmailHttpServer> {
  const hostname = options.hostname ?? "127.0.0.1";
  const requestedPort = options.port ?? 0;
  const { apiKey } = options;
  const maxRequestBodyBytes = options.maxRequestBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES;
  if (!Number.isSafeInteger(maxRequestBodyBytes) || maxRequestBodyBytes < 1) {
    throw new TypeError("maxRequestBodyBytes must be a positive safe integer.");
  }
  if (!apiKey && !isLoopbackHostname(hostname)) {
    throw new TypeError("apiKey is required when hostname is not loopback.");
  }
  const corsOrigins = new Set(
    (options.corsOrigins ?? []).map((origin) => origin.trim()).filter(Boolean),
  );

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    const method = request.method ?? "GET";
    const url = request.url ?? "/";
    const path = url.split("?")[0] ?? "/";
    const origin = request.headers.origin;
    const isCorsRequest = corsOrigins.size > 0 && typeof origin === "string";
    const isAllowedOrigin = isCorsRequest && corsOrigins.has(origin);

    if (isCorsRequest) {
      appendVaryHeader(response, "Origin");
      if (isAllowedOrigin) {
        response.setHeader("access-control-allow-origin", origin);
      }
    }

    if (
      corsOrigins.size > 0
      && method === "OPTIONS"
      && request.headers["access-control-request-method"] !== undefined
    ) {
      if (!isAllowedOrigin) {
        writeJson(response, 403, {
          error: "CORS_ORIGIN_DENIED",
          message: "The request origin is not allowed.",
        });
        return;
      }

      response.statusCode = 204;
      response.setHeader("access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
      response.setHeader("access-control-allow-headers", "Authorization, Content-Type, Idempotency-Key");
      response.setHeader("access-control-max-age", "600");
      response.end();
      return;
    }

    if (!apiKey && method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.snapshot) {
      writeJson(response, 403, {
        code: "SNAPSHOT_AUTH_REQUIRED",
        error: "SNAPSHOT_AUTH_REQUIRED",
        message: "Configure server.apiKey and authenticate to read the full service snapshot.",
      });
      return;
    }

    if (!checkApiKey(apiKey, request, response)) {
      return;
    }

    if (options.bundledInstanceNonce) {
      response.setHeader("x-easyemail-bundled-nonce", options.bundledInstanceNonce);
    }

    const readBodyJson = <T>() => readJsonBody<T>(request, maxRequestBodyBytes);

    try {
      const query = parseQueryString(url);
      const result = await handleOmnimailWorkbenchRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleImapSyncRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleAgentMailRoute({
        method,
        path,
        query,
        headers: request.headers,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleAvatarMailRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleExtensionsRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleAdminRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
        extractProviderProbeInstanceId,
        extractObservedMessageId,
      }) ?? await handleSendQueueRoute({
        method,
        path,
        query,
        headers: request.headers,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handleMessageRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
      }) ?? await handlePublicRoute({
        method,
        path,
        handler,
        readJsonBody: readBodyJson,
        extractVerificationCodeSessionId,
        extractAuthenticationLinkSessionId,
        extractMailboxRefreshSessionId,
      }) ?? await handleInternalRoute({
        method,
        path,
        handler,
      });

      if (result !== undefined) {
        writeJson(response, 200, result);
        return;
      }

      writeJson(response, 404, { error: "EASY_EMAIL_ROUTE_NOT_FOUND", path, method });
    } catch (error) {
      if (error instanceof EasyEmailError) {
        const mappedStatus = resolveEasyEmailHttpErrorStatus(error);
        if (mappedStatus !== undefined) {
          writeEasyEmailError(response, mappedStatus, error);
          return;
        }
        reportHttpFailure(method, path, error);
        writeEasyEmailError(response, 500, error);
        return;
      }

      reportHttpFailure(method, path, error);
      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };

  let closing = false;
  let closePromise: Promise<void> | undefined;
  const requestTasks = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    if (closing) {
      response.setHeader("connection", "close");
      writeJson(response, 503, { error: "EASY_EMAIL_SHUTTING_DOWN" });
      return;
    }
    // A disconnected socket does not cancel its in-flight provider or registry work.
    const task = handleRequest(request, response).catch(() => {
      console.error("easy_email_http_request_failed");
      response.destroy();
    });
    requestTasks.add(task);
    void task.then(() => requestTasks.delete(task));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, hostname, () => {
      server.removeListener("error", reject);
      const address = server.address();
      const port = (address as { port: number } | null)?.port ?? requestedPort;
      resolve({
        baseUrl: `http://${hostname}:${port}`,
        hostname,
        port,
        close() {
          if (!closePromise) {
            closing = true;
            handler.omnimail.closeMemorySessions();
            const listenerClosed = new Promise<void>((res, rej) => {
              server.close((error) => error ? rej(error) : res());
              server.closeIdleConnections?.();
            });
            closePromise = Promise.allSettled([listenerClosed, ...requestTasks]).then((results) => {
              const failure = results.find((result) => result.status === "rejected");
              if (failure?.status === "rejected") throw failure.reason;
            });
          }
          return closePromise;
        },
      });
    });
  });
}
