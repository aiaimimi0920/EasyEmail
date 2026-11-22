import { EasyEmailError } from "../../domain/errors.js";
import type { SyncMailAccountHttpRequest } from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface ImapSyncRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
}

function decodeAccountPathSegment(rawSegment: string): string {
  try {
    return decodeURIComponent(rawSegment);
  } catch {
    throw new EasyEmailError("INVALID_ACCOUNT", "Account id path encoding is invalid.");
  }
}

function parseOptionalBooleanQuery(
  value: string | undefined,
  fieldName: string,
): boolean | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") {
    return true;
  }
  if (normalized === "false" || normalized === "0") {
    return false;
  }
  throw new EasyEmailError("INVALID_QUERY", `${fieldName} must be true or false.`);
}

function extractAccountActionId(
  path: string,
  action: "folders" | "sync",
): string | undefined {
  const matched = path.match(new RegExp(`^\\/mail\\/accounts\\/([^/]+)\\/${action}$`));
  return matched?.[1] ? decodeAccountPathSegment(matched[1]) : undefined;
}

export async function handleImapSyncRoute(
  context: ImapSyncRouteContext,
): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody } = context;

  if (method === "GET") {
    const foldersAccountId = extractAccountActionId(path, "folders");
    if (foldersAccountId) {
      return handler.listMailAccountFolders(foldersAccountId, {
        refresh: parseOptionalBooleanQuery(query.refresh, "refresh"),
      });
    }
    const syncStatusAccountId = extractAccountActionId(path, "sync");
    if (syncStatusAccountId) {
      return handler.getMailAccountSyncStatus(syncStatusAccountId);
    }
  }

  if (method === "POST") {
    const syncAccountId = extractAccountActionId(path, "sync");
    if (syncAccountId) {
      return handler.syncMailAccount(
        syncAccountId,
        await readJsonBody<SyncMailAccountHttpRequest>(),
      );
    }
  }

  return undefined;
}
