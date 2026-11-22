import { EasyEmailError } from "../../domain/errors.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type PromoteMailboxHttpRequest,
  type TestEasyEmailConnectionHttpRequest,
  type UpdateEasyEmailSettingsHttpRequest,
  type UpdateNewsletterSubscriptionHttpRequest,
} from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface ExtensionsRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function decodePathSegment(rawSegment: string, label: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new EasyEmailError("INVALID_QUERY", `${label} path encoding is invalid.`);
  }
}

function extractPromoteSessionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/mailboxes\/([^/]+)\/promote$/u);
  return matched?.[1] ? decodePathSegment(matched[1], "Session id") : undefined;
}

function extractNewsletterSubscriptionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/newsletters\/subscriptions\/([^/]+)$/u);
  return matched?.[1] ? decodePathSegment(matched[1], "Subscription id") : undefined;
}

export async function handleExtensionsRoute(
  context: ExtensionsRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody } = context;

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.newsletterSubscriptions) {
    return handler.listNewsletterSubscriptions({
      accountId: query.accountId ?? "",
    });
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.settingsEasyEmail) {
    return handler.getEasyEmailSettings();
  }

  if (method === "PATCH" && path === EASY_EMAIL_HTTP_ROUTES.settingsEasyEmail) {
    return handler.updateEasyEmailSettings(
      await readJsonBody<UpdateEasyEmailSettingsHttpRequest>(),
    );
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.testSettingsEasyEmail) {
    return handler.testEasyEmailConnection(
      await readJsonBody<TestEasyEmailConnectionHttpRequest>(),
    );
  }

  if (method === "POST") {
    const promoteSessionId = extractPromoteSessionId(path);
    if (promoteSessionId) {
      return handler.promoteMailboxSession(
        promoteSessionId,
        await readJsonBody<PromoteMailboxHttpRequest>(),
      );
    }
  }

  if (method === "PATCH") {
    const subscriptionId = extractNewsletterSubscriptionId(path);
    if (subscriptionId) {
      return handler.setNewsletterSubscriptionHidden(
        subscriptionId,
        await readJsonBody<UpdateNewsletterSubscriptionHttpRequest>(),
      );
    }
  }

  return undefined;
}
