import type { IncomingHttpHeaders } from "node:http";

import { EasyEmailError } from "../../domain/errors.js";
import type { MailAgentThreadStatus } from "../../domain/mail-agent.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type CreateAgentMailAccountHttpRequest,
  type CreateAgentMailServiceHttpRequest,
  type SendAgentMailTaskHttpRequest,
} from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface AgentMailRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingHttpHeaders;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function parseOptionalIntQuery(value: string | undefined, fieldName: string): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^\d+$/u.test(value.trim())) {
    throw new EasyEmailError("INVALID_QUERY", `${fieldName} must be a positive integer.`);
  }
  return Number.parseInt(value.trim(), 10);
}

function extractAgentThreadId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/agent\/threads\/([^/]+)$/u);
  if (!matched?.[1]) return undefined;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    throw new EasyEmailError("INVALID_QUERY", "Agent thread id path encoding is invalid.");
  }
}

export async function handleAgentMailRoute(
  context: AgentMailRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, headers, handler, readJsonBody } = context;

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.agentAccounts) {
    return handler.listAgentMailAccounts({
      limit: parseOptionalIntQuery(query.limit, "limit"),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.agentAccounts) {
    return handler.createAgentMailAccount(
      await readJsonBody<CreateAgentMailAccountHttpRequest>(),
    );
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.agentServices) {
    return handler.listAgentMailServices();
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.agentServices) {
    return handler.createAgentMailService(
      await readJsonBody<CreateAgentMailServiceHttpRequest>(),
    );
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.agentTasks) {
    const rawHeader = headers["idempotency-key"];
    const idempotencyKey = typeof rawHeader === "string" ? rawHeader : undefined;
    return handler.sendAgentMailTask(
      await readJsonBody<SendAgentMailTaskHttpRequest>(),
      idempotencyKey,
    );
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.agentThreads) {
    return handler.listAgentMailThreads({
      status: (query.status || undefined) as MailAgentThreadStatus | undefined,
      senderAccountId: query.senderAccountId || undefined,
      agentServiceId: query.agentServiceId || undefined,
      limit: parseOptionalIntQuery(query.limit, "limit"),
    });
  }

  if (method === "GET") {
    const threadId = extractAgentThreadId(path);
    if (threadId) {
      return handler.getAgentMailThreadDetail(threadId);
    }
  }

  return undefined;
}
