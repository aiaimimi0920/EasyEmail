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
