import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailMessageDetailScope,
  MailMessageListScope,
  MailVerificationAccountScope,
} from "../../domain/mail-message.js";
import { EASY_EMAIL_HTTP_ROUTES } from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface MessageRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function decodeMessagePathSegment(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new EasyEmailError("INVALID_MAIL_MESSAGE", "Mail message path encoding is invalid.");
  }
}

function parsePositiveIntegerQuery(
  value: string | undefined,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (!/^[1-9]\d*$/.test(value)) {
    throw new EasyEmailError("INVALID_QUERY", `${fieldName} must be a positive integer.`);
  }
  return Number(value);
}

function parseBooleanQuery(
  value: string | undefined,
  fieldName: string,
): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new EasyEmailError("INVALID_QUERY", `${fieldName} query value is invalid: ${value}`);
}

function extractMailDraftId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/drafts\/([^/]+)$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageId(path: string): string | undefined {
  if (path === EASY_EMAIL_HTTP_ROUTES.observeMessage) {
    return undefined;
  }
  const matched = path.match(/^\/mail\/messages\/([^/]+)$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageLocalId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/local$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageFlagsId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/flags$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageFolderId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/folder$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageLabelsId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/labels$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailMessageReclassifyId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/messages\/([^/]+)\/reclassify-verification$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

function extractMailboxVerificationPollSessionId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/mailboxes\/([^/]+)\/verification\/poll$/);
  return matched?.[1] ? decodeMessagePathSegment(matched[1]) : undefined;
}

export async function handleMessageRoute(
  context: MessageRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody } = context;

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.drafts) {
    return handler.saveLocalDraft(await readJsonBody());
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.messages) {
    return handler.listMailMessages({
      scope: (query.scope || undefined) as MailMessageListScope | undefined,
      accountId: query.accountId || undefined,
      sessionId: query.sessionId || undefined,
      folder: query.folder || undefined,
      label: query.label || undefined,
      search: query.search || undefined,
      includeArchived: parseBooleanQuery(query.includeArchived, "includeArchived"),
      limit: parsePositiveIntegerQuery(query.limit, "limit"),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "DELETE" && path === EASY_EMAIL_HTTP_ROUTES.trash) {
    return handler.emptyMailTrash(await readJsonBody());
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.verifications) {
    return handler.listMailVerifications({
      sessionId: query.sessionId || undefined,
      scope: (query.scope || undefined) as MailVerificationAccountScope | "all" | undefined,
      freshOnly: parseBooleanQuery(query.freshOnly, "freshOnly"),
      limit: parsePositiveIntegerQuery(query.limit, "limit"),
    });
  }

  const draftId = extractMailDraftId(path);
  if (method === "DELETE" && draftId) {
    return handler.deleteLocalDraft(draftId);
  }

  const localDeleteId = extractMailMessageLocalId(path);
  if (method === "DELETE" && localDeleteId) {
    return handler.deleteMailMessageLocal(localDeleteId);
  }

  const flagMessageId = extractMailMessageFlagsId(path);
  if (method === "PATCH" && flagMessageId) {
    return handler.setMailMessageLocalFlag(flagMessageId, await readJsonBody());
  }

  const folderMessageId = extractMailMessageFolderId(path);
  if (method === "PATCH" && folderMessageId) {
    return handler.setMailMessageLocalFolder(folderMessageId, await readJsonBody());
  }

  const labelMessageId = extractMailMessageLabelsId(path);
  if (method === "PATCH" && labelMessageId) {
    return handler.setMailMessageLocalLabel(labelMessageId, await readJsonBody());
  }

  const reclassifyId = extractMailMessageReclassifyId(path);
  if (method === "POST" && reclassifyId) {
    return handler.reclassifyMailMessageVerification(reclassifyId);
  }

  const pollSessionId = extractMailboxVerificationPollSessionId(path);
  if (method === "POST" && pollSessionId) {
    return handler.pollMailboxVerification(pollSessionId);
  }

  const messageId = extractMailMessageId(path);
  if (method === "GET" && messageId) {
    return handler.getMailMessageDetail(messageId, {
      scope: (query.scope || undefined) as MailMessageDetailScope | undefined,
      includeRawHtml: parseBooleanQuery(query.includeRawHtml, "includeRawHtml"),
    });
  }

  if (method === "DELETE" && messageId) {
    return handler.deleteMailMessageForever(messageId);
  }

  return undefined;
}
