import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EasyEmailError } from "../domain/errors.js";
import { EasyEmailHttpHandler } from "./handler.js";
import { handleAdminRoute } from "./routes/admin.js";
import { handleInternalRoute } from "./routes/internal.js";
import { handlePublicRoute } from "./routes/public.js";

export interface EasyEmailHttpServerOptions {
  hostname?: string;
  port?: number;
  apiKey?: string;
  corsOrigins?: readonly string[];
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

function decodeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === "string") return chunk;
  return new TextDecoder("utf-8").decode(chunk);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => { body += decodeChunk(chunk); });
    request.on("end", () => { resolve(body); });
    request.on("error", reject);
  });
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
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
  const corsOrigins = new Set(
    (options.corsOrigins ?? []).map((origin) => origin.trim()).filter(Boolean),
  );

  const server = createServer(async (request, response) => {
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
      response.setHeader("access-control-allow-headers", "Authorization, Content-Type");
      response.setHeader("access-control-max-age", "600");
      response.end();
      return;
    }

    if (!checkApiKey(apiKey, request, response)) {
      return;
    }

    const readBodyJson = <T>() => readJsonBody<T>(request);

    try {
      const query = parseQueryString(url);
      const result = await handleAdminRoute({
        method,
        path,
        query,
        handler,
        readJsonBody: readBodyJson,
        extractProviderProbeInstanceId,
        extractObservedMessageId,
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
      if (error instanceof EasyEmailError && ["INVALID_JSON", "INVALID_QUERY"].includes(error.code)) {
        writeEasyEmailError(response, 400, error);
        return;
      }

      if (
        error instanceof EasyEmailError
        && [
          "INVALID_CONTACT",
          "INVALID_CONTACT_CURSOR",
          "INVALID_MAIL_TAXONOMY",
          "INVALID_MAIL_TAXONOMY_CURSOR",
          "MAIL_TAXONOMY_KIND_UNSUPPORTED",
          "MAIL_TAXONOMY_PARENT_UNSUPPORTED",
          "MAIL_TAXONOMY_PARENT_NOT_FOUND",
          "MAIL_TAXONOMY_PARENT_CYCLE",
          "INVALID_ACCOUNT",
          "INVALID_ACCOUNT_CURSOR",
          "ACCOUNT_CREDENTIAL_REF_INVALID",
          "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN",
          "ACCOUNT_SCOPE_UNSUPPORTED",
          "ACCOUNT_KIND_UNSUPPORTED",
        ].includes(error.code)
      ) {
        writeEasyEmailError(response, 400, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "MAILBOX_SESSION_NOT_FOUND") {
        writeEasyEmailError(response, 404, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "CONTACT_NOT_FOUND") {
        writeEasyEmailError(response, 404, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "MAIL_TAXONOMY_NOT_FOUND") {
        writeEasyEmailError(response, 404, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "ACCOUNT_NOT_FOUND") {
        writeEasyEmailError(response, 404, error);
        return;
      }

      if (
        error instanceof EasyEmailError
        && ["CONTACT_VERSION_CONFLICT", "CONTACT_EMAIL_CONFLICT"].includes(error.code)
      ) {
        writeEasyEmailError(response, 409, error);
        return;
      }

      if (
        error instanceof EasyEmailError
        && [
          "MAIL_TAXONOMY_VERSION_CONFLICT",
          "MAIL_TAXONOMY_NAME_CONFLICT",
          "ACCOUNT_VERSION_CONFLICT",
          "ACCOUNT_ADDRESS_CONFLICT",
          "ACCOUNT_CREDENTIAL_REF_CONFLICT",
          "ACCOUNT_SYSTEM_MANAGED",
          "ACCOUNT_REAUTHENTICATION_REQUIRED",
          "ACCOUNT_IMAP_CONFIG_REQUIRED",
          "ACCOUNT_IMAP_TEST_UNSUPPORTED",
        ].includes(error.code)
      ) {
        writeEasyEmailError(response, 409, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "CONTACTS_PERSISTENCE_UNAVAILABLE") {
        writeEasyEmailError(response, 503, error);
        return;
      }

      if (
        error instanceof EasyEmailError
        && error.code === "MAIL_TAXONOMY_PERSISTENCE_UNAVAILABLE"
      ) {
        writeEasyEmailError(response, 503, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "ACCOUNTS_PERSISTENCE_UNAVAILABLE") {
        writeEasyEmailError(response, 503, error);
        return;
      }

      if (
        error instanceof EasyEmailError
        && [
          "ACCOUNT_CREDENTIAL_UNAVAILABLE",
          "ACCOUNT_IMAP_TEST_UNAVAILABLE",
          "ACCOUNT_IMAP_UNAVAILABLE",
        ].includes(error.code)
      ) {
        writeEasyEmailError(response, 503, error);
        return;
      }

      if (error instanceof EasyEmailError && error.code === "IMAP_AUTH_FAILED") {
        writeEasyEmailError(response, 422, error);
        return;
      }

      if (error instanceof EasyEmailError) {
        writeEasyEmailError(response, 500, error);
        return;
      }

      writeJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  return new Promise((resolve) => {
    server.listen(requestedPort, hostname, () => {
      const address = server.address();
      const port = (address as { port: number } | null)?.port ?? requestedPort;
      resolve({
        baseUrl: `http://${hostname}:${port}`,
        hostname,
        port,
        close() {
          return new Promise((res, rej) => server.close((e) => (e ? rej(e) : res())));
        },
      });
    });
  });
}
