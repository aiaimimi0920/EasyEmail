import { EasyEmailError } from "../../domain/errors.js";
import type {
  HostBindingQueryFilters,
  MailProviderTypeKey,
  MailboxSessionQueryFilters,
  ObservedMessageQueryFilters,
  ProviderInstanceQueryFilters,
  ProviderInstanceStatus,
} from "../../domain/models.js";
import { normalizeMailProviderTypeKey } from "../../domain/models.js";
import type { MailTaxonomyKind } from "../../domain/mail-taxonomy.js";
import { EASY_EMAIL_HTTP_ROUTES } from "../contracts.js";
import type { EasyEmailHttpHandler } from "../handler.js";

export interface AdminRouteContext {
  method: string;
  path: string;
  query: Record<string, string>;
  handler: EasyEmailHttpHandler;
  readJsonBody<T>(): Promise<T>;
  extractProviderProbeInstanceId(path: string): string | undefined;
  extractObservedMessageId(path: string): string | undefined;
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
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

  throw new EasyEmailError("INVALID_QUERY", `Boolean query value is invalid: ${value}`);
}

function parseLimitQuery(value: string | undefined): number | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new EasyEmailError("INVALID_QUERY", `Limit query value is invalid: ${value}`);
  }

  return parsed;
}

function parseExpectedVersion(value: string | undefined): number {
  const parsed = value === undefined ? Number.NaN : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== value) {
    throw new EasyEmailError("INVALID_QUERY", "expectedVersion must be a positive integer.");
  }
  return parsed;
}

function parseContactLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new EasyEmailError("INVALID_QUERY", "Contact limit must be a positive integer.");
  }
  return Number(value);
}

function extractContactId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/contacts\/([^/]+)$/);
  if (!matched?.[1]) return undefined;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    throw new EasyEmailError("INVALID_CONTACT", "Contact id path encoding is invalid.");
  }
}

function extractMailAccountId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/accounts\/([^/]+)$/);
  if (!matched?.[1]) return undefined;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    throw new EasyEmailError("INVALID_ACCOUNT", "Account id path encoding is invalid.");
  }
}

function extractMailAccountDisableId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/accounts\/([^/]+)\/disable$/);
  if (!matched?.[1]) return undefined;
  try {
    return decodeURIComponent(matched[1]);
  } catch {
    throw new EasyEmailError("INVALID_ACCOUNT", "Account id path encoding is invalid.");
  }
}

function parseAccountScope(value: string | undefined): "normal" | "agent" | "system" | undefined {
  if (value === undefined || value === "") return undefined;
  if (value !== "normal" && value !== "agent" && value !== "system") {
    throw new EasyEmailError("ACCOUNT_SCOPE_UNSUPPORTED", "Account scope is unsupported.");
  }
  return value;
}

function parseAccountLimit(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  if (!/^[1-9]\d*$/.test(value)) {
    throw new EasyEmailError("INVALID_QUERY", "Account limit must be a positive integer.");
  }
  return Number(value);
}

function decodeTaxonomyPathPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new EasyEmailError(
      "INVALID_MAIL_TAXONOMY",
      "Mail taxonomy path encoding is invalid.",
    );
  }
}

function extractMailTaxonomyUpsertTarget(
  path: string,
): { kind: MailTaxonomyKind; key: string } | undefined {
  const matched = path.match(/^\/mail\/taxonomy\/([^/]+)\/([^/]+)$/);
  if (!matched?.[1] || !matched[2]) return undefined;
  const kind = decodeTaxonomyPathPart(matched[1]);
  if (kind !== "folder" && kind !== "label") {
    throw new EasyEmailError(
      "MAIL_TAXONOMY_KIND_UNSUPPORTED",
      "Mail taxonomy kind must be folder or label.",
    );
  }
  return { kind, key: decodeTaxonomyPathPart(matched[2]) };
}

function extractMailTaxonomyItemId(path: string): string | undefined {
  const matched = path.match(/^\/mail\/taxonomy\/([^/]+)$/);
  return matched?.[1] ? decodeTaxonomyPathPart(matched[1]) : undefined;
}

function parseMailTaxonomyKind(value: string | undefined): MailTaxonomyKind {
  if (value !== "folder" && value !== "label") {
    throw new EasyEmailError(
      "MAIL_TAXONOMY_KIND_UNSUPPORTED",
      "Mail taxonomy kind query must be folder or label.",
    );
  }
  return value;
}

function parseProviderInstanceFilters(query: Record<string, string>): ProviderInstanceQueryFilters {
  const filters: ProviderInstanceQueryFilters = {};
  if (query.providerTypeKey) {
    filters.providerTypeKey = normalizeMailProviderTypeKey(query.providerTypeKey) as MailProviderTypeKey | undefined;
  }
  if (query.status) {
    filters.status = query.status as ProviderInstanceStatus;
  }
  const shared = parseBooleanQuery(query.shared);
  if (shared !== undefined) {
    filters.shared = shared;
  }
  if (query.groupKey) {
    filters.groupKey = query.groupKey;
  }
  const limit = parseLimitQuery(query.limit);
  if (limit !== undefined) {
    filters.limit = limit;
  }
  return filters;
}

function parseHostBindingFilters(query: Record<string, string>): HostBindingQueryFilters {
  const filters: HostBindingQueryFilters = {};
  if (query.hostId) {
    filters.hostId = query.hostId;
  }
  if (query.providerTypeKey) {
    filters.providerTypeKey = normalizeMailProviderTypeKey(query.providerTypeKey) as MailProviderTypeKey | undefined;
  }
  if (query.instanceId) {
    filters.instanceId = query.instanceId;
  }
  const limit = parseLimitQuery(query.limit);
  if (limit !== undefined) {
    filters.limit = limit;
  }
  return filters;
}

function parseMailboxSessionFilters(query: Record<string, string>): MailboxSessionQueryFilters {
  const filters: MailboxSessionQueryFilters = {};
  if (query.hostId) {
    filters.hostId = query.hostId;
  }
  if (query.providerTypeKey) {
    filters.providerTypeKey = normalizeMailProviderTypeKey(query.providerTypeKey) as MailProviderTypeKey | undefined;
  }
  if (query.providerInstanceId) {
    filters.providerInstanceId = query.providerInstanceId;
  }
  if (query.status) {
    filters.status = query.status as MailboxSessionQueryFilters["status"];
  }
  const limit = parseLimitQuery(query.limit);
  if (limit !== undefined) {
    filters.limit = limit;
  }
  const newestFirst = parseBooleanQuery(query.newestFirst);
  if (newestFirst !== undefined) {
    filters.newestFirst = newestFirst;
  }
  return filters;
}

function parseObservedMessageFilters(query: Record<string, string>): ObservedMessageQueryFilters {
  const filters: ObservedMessageQueryFilters = {};
  if (query.sessionId) {
    filters.sessionId = query.sessionId;
  }
  if (query.providerInstanceId) {
    filters.providerInstanceId = query.providerInstanceId;
  }
  const extractedCodeOnly = parseBooleanQuery(query.extractedCodeOnly);
  if (extractedCodeOnly !== undefined) {
    filters.extractedCodeOnly = extractedCodeOnly;
  }
  const sync = parseBooleanQuery(query.sync);
  if (sync !== undefined) {
    filters.sync = sync;
  }
  const limit = parseLimitQuery(query.limit);
  if (limit !== undefined) {
    filters.limit = limit;
  }
  const newestFirst = parseBooleanQuery(query.newestFirst);
  if (newestFirst !== undefined) {
    filters.newestFirst = newestFirst;
  }
  return filters;
}

export async function handleAdminRoute(context: AdminRouteContext): Promise<unknown | undefined> {
  const { method, path, query, handler, readJsonBody, extractProviderProbeInstanceId, extractObservedMessageId } = context;

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.registerCloudflareTempEmailRuntime) {
    return handler.registerCloudflareTempEmailRuntime(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.applyCredentialSets) {
    return handler.applyCredentialSets(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.contacts) {
    return handler.createContact(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.accounts) {
    return handler.createMailAccount(await readJsonBody());
  }

  if (method === "POST" && path === EASY_EMAIL_HTTP_ROUTES.testAccountImap) {
    return handler.testMailAccountImap(await readJsonBody());
  }

  const accountDisableId = extractMailAccountDisableId(path);
  if (method === "POST" && accountDisableId) {
    return handler.disableMailAccount(accountDisableId, await readJsonBody());
  }

  const accountId = extractMailAccountId(path);
  if (method === "PATCH" && accountId) {
    return handler.updateMailAccount(accountId, await readJsonBody());
  }

  if (method === "DELETE" && accountId) {
    return handler.deleteMailAccount(accountId, {
      expectedVersion: parseExpectedVersion(query.expectedVersion),
    });
  }

  const taxonomyUpsertTarget = extractMailTaxonomyUpsertTarget(path);
  if (method === "PUT" && taxonomyUpsertTarget) {
    return handler.upsertMailTaxonomy(
      taxonomyUpsertTarget.kind,
      taxonomyUpsertTarget.key,
      await readJsonBody(),
    );
  }

  const taxonomyItemId = extractMailTaxonomyItemId(path);
  if (method === "PATCH" && taxonomyItemId) {
    return handler.updateMailTaxonomy(taxonomyItemId, await readJsonBody());
  }

  if (method === "DELETE" && taxonomyItemId) {
    return handler.deleteMailTaxonomy(taxonomyItemId, {
      expectedVersion: parseExpectedVersion(query.expectedVersion),
    });
  }

  const contactId = extractContactId(path);
  if (method === "PATCH" && contactId) {
    return handler.updateContact(contactId, await readJsonBody());
  }

  if (method === "DELETE" && contactId) {
    return handler.deleteContact(contactId, {
      expectedVersion: parseExpectedVersion(query.expectedVersion),
    });
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.probeAllProviderInstances) {
    return handler.probeAllProviderInstances();
  }

  const providerProbeInstanceId = extractProviderProbeInstanceId(path);
  if (method === "GET" && providerProbeInstanceId) {
    return handler.probeProviderInstance(providerProbeInstanceId);
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.queryProviderInstances) {
    return handler.queryProviderInstances(parseProviderInstanceFilters(query));
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.contacts) {
    return handler.listContacts({
      limit: parseContactLimit(query.limit),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.accounts) {
    return handler.listMailAccounts({
      scope: parseAccountScope(query.scope),
      limit: parseAccountLimit(query.limit),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "GET" && contactId) {
    return handler.getContact(contactId);
  }

  if (method === "GET" && accountId) {
    return handler.getMailAccount(accountId);
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.taxonomy) {
    return handler.listMailTaxonomy({
      kind: parseMailTaxonomyKind(query.kind),
      limit: parseContactLimit(query.limit),
      cursor: query.cursor || undefined,
    });
  }

  if (method === "GET" && taxonomyItemId) {
    return handler.getMailTaxonomy(taxonomyItemId);
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.queryHostBindings) {
    return handler.queryHostBindings(parseHostBindingFilters(query));
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.queryMailboxSessions) {
    return handler.queryMailboxSessions(parseMailboxSessionFilters(query));
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.queryObservedMessages) {
    return handler.queryObservedMessages(parseObservedMessageFilters(query));
  }

  const observedMessageId = extractObservedMessageId(path);
  if (method === "GET" && observedMessageId) {
    return handler.getObservedMessage(observedMessageId);
  }

  if (method === "GET" && path === EASY_EMAIL_HTTP_ROUTES.persistenceStats) {
    return handler.getPersistenceStats();
  }

  return undefined;
}
