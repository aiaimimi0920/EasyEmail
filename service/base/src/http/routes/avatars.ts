import { EasyEmailError } from "../../domain/errors.js";
import {
  EASY_EMAIL_HTTP_ROUTES,
  type SetMailContactAvatarHttpRequest,
  type ResolveMailSenderAvatarsHttpRequest,
  type UpdateMailAvatarSettingsHttpRequest,
} from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface AvatarMailRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function parseOptionalBooleanQuery(
  value: string | undefined,
  fieldName: string,
): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  throw new EasyEmailError("INVALID_QUERY", `${fieldName} must be a boolean.`);
}

function extractAvatarContactId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/avatars\/contacts\/([^/]+)$/u);
  if (!matched?.[1]) return undefined;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    throw new EasyEmailError("INVALID_QUERY", "Avatar contact id path encoding is invalid.");
  }
}

export async function handleAvatarMailRoute(
  context: AvatarMailRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody } = context;

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.avatarSettings) {
    return handler.getMailAvatarSettings();
  }

  if (method === "PATCH" && path === EASY_EMAIL_HTTP_ROUTES.avatarSettings) {
    return handler.updateMailAvatarSettings(
      await readJsonBody<UpdateMailAvatarSettingsHttpRequest>(),
    );
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.avatarResolve) {
    return handler.resolveMailSenderAvatars(
      await readJsonBody<ResolveMailSenderAvatarsHttpRequest>(),
    );
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.avatarCache) {
    return handler.clearMailAvatarCache({
      includeContacts: parseOptionalBooleanQuery(query.includeContacts, "includeContacts"),
    });
  }

  if (method === "PUT" || method === "DELETE") {
    const contactId = extractAvatarContactId(path);
    if (contactId) {
      if (method === "PUT") {
        return handler.setMailContactAvatar(
          contactId,
          await readJsonBody<SetMailContactAvatarHttpRequest>(),
        );
      }
      return handler.clearMailContactAvatar(contactId);
    }
  }

  return undefined;
}
