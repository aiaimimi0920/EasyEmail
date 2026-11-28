import { sanitizeSafeMailHtml } from "../../base/src/domain/mail-safe-html-engine";
import { HttpError } from "./http";
import {
  mapWorkBuddyRestError,
  requestWorkBuddyGateway,
  unwrapWorkBuddyEnvelope,
  type WorkBuddyAlias,
  type WorkBuddyDailyQuota,
  type WorkBuddyTokenCredentials,
} from "./workbuddy-auth";

export {
  DEFAULT_WORKBUDDY_BASE_URL,
  pollWorkBuddyAuthTokenOnce,
  refreshWorkBuddyToken,
  requestWorkBuddyGateway,
  resolveWorkBuddyBaseUrl,
  startWorkBuddyBrowserAuth,
  validateWorkBuddyAuthBrowserUrl,
  type WorkBuddyAlias,
  type WorkBuddyDailyQuota,
  type WorkBuddyTokenCredentials,
} from "./workbuddy-auth";

const MAX_ATTACHMENT_JSON_BYTES = 36 * 1024 * 1024;
const MAX_ATTACHMENT_DECODED_BYTES = 25 * 1024 * 1024;

export interface WorkBuddyMessageSummary {
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  snippet: string;
  createdAt: string;
  isRead: boolean;
  hasAttachments: boolean;
  direction: "inbox" | "sent";
}

export interface WorkBuddyMessageDetail {
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  createdAt: string;
  isRead: boolean;
  bodyFormat: "HTML" | "TEXT";
  sanitizedHtml: string;
  plainText: string;
  hasRemoteImages: boolean;
  attachments: Array<{ attachmentId: string; filename: string; size: number; contentType: string }>;
  dailyQuota: WorkBuddyDailyQuota;
}

function parseAddress(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (raw && typeof raw === "object") {
    const obj = raw as { email?: string; name?: string };
    if (obj.name && obj.email) return `${obj.name} <${obj.email}>`;
    return (obj.email ?? "").trim();
  }
  return "";
}

function parseAddressList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(parseAddress).filter(Boolean);
  const single = parseAddress(raw);
  return single ? [single] : [];
}

export async function fetchWorkBuddyProfileAndAliases(
  creds: WorkBuddyTokenCredentials,
  allowLoopback = false,
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>,
): Promise<{ mailboxStatus: string; aliases: WorkBuddyAlias[]; primary: WorkBuddyAlias; quota: WorkBuddyDailyQuota }> {
  const meResp = await requestWorkBuddyGateway({
    creds,
    method: "GET",
    relPath: "/console/agent-gateway/agentmailrest/v1/me",
    allowLoopback,
    onRefreshed,
  });
  mapWorkBuddyRestError(meResp.status, meResp.body);
  const env = unwrapWorkBuddyEnvelope(meResp.body);
  const data = (env.data ?? {}) as {
    aliases?: Array<{ alias_id?: string; aliasId?: string; email?: string; is_primary?: boolean }>;
    daily_quota?: { limit?: number; remaining?: number; reset?: number };
  };
  const aliases: WorkBuddyAlias[] = [];
  for (const item of data.aliases ?? []) {
    const aliasId = (item.alias_id || item.aliasId || "").trim();
    const email = (item.email ?? "").trim();
    if (aliasId && email) aliases.push({ aliasId, email, isPrimary: Boolean(item.is_primary) });
  }
  if (aliases.length === 0) throw new HttpError(409, "workbuddy_not_bound");
  const primary = aliases.find((a) => a.isPrimary) ?? aliases[0]!;
  const quota = meResp.quota.hasQuota
    ? meResp.quota
    : {
        limit: data.daily_quota?.limit ?? 0,
        remaining: data.daily_quota?.remaining ?? 0,
        reset: data.daily_quota?.reset ?? 0,
        hasQuota: Boolean(data.daily_quota),
      };
  return { mailboxStatus: "running", aliases, primary, quota };
}

export async function listWorkBuddyAliasMessages(input: {
  creds: WorkBuddyTokenCredentials;
  aliasId: string;
  dir: "inbox" | "sent";
  query?: string;
  cursor?: string;
  limit?: number;
  allowLoopback?: boolean;
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>;
}): Promise<{ items: WorkBuddyMessageSummary[]; nextCursor: string; hasMore: boolean; dailyQuota: WorkBuddyDailyQuota }> {
  const qs: Record<string, string> = {
    dir: input.dir,
    limit: String(Math.min(Math.max(input.limit ?? 50, 1), 100)),
  };
  if (input.cursor?.trim()) qs.cursor = input.cursor.trim();
  let relPath = `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(input.aliasId)}/messages`;
  if (input.query?.trim()) {
    relPath += "/search";
    qs.q = input.query.trim();
    qs.search_in = "SEARCH_IN_ALL";
  }
  const resp = await requestWorkBuddyGateway({
    creds: input.creds,
    method: "GET",
    relPath,
    query: qs,
    allowLoopback: input.allowLoopback,
    onRefreshed: input.onRefreshed,
  });
  mapWorkBuddyRestError(resp.status, resp.body);
  const raw = (resp.body ?? {}) as {
    data?: Array<Record<string, unknown>>;
    pagination?: { next_cursor?: string; has_more?: boolean };
  };
  const items: WorkBuddyMessageSummary[] = (raw.data ?? [])
    .map((item) => ({
      messageId: String(item.message_id ?? "").trim(),
      subject: String(item.subject ?? "").trim(),
      from: parseAddress(item.from),
      to: parseAddressList(item.to),
      snippet: String(item.snippet ?? "").trim(),
      createdAt: String(item.created_at ?? ""),
      isRead: Boolean(item.is_read),
      hasAttachments: Boolean(item.has_attachments) || (Array.isArray(item.attachments) && item.attachments.length > 0),
      direction: input.dir,
    }))
    .filter((item) => item.messageId.length > 0);
  return {
    items,
    nextCursor: (raw.pagination?.next_cursor ?? "").trim(),
    hasMore: Boolean(raw.pagination?.has_more),
    dailyQuota: resp.quota,
  };
}

export async function getWorkBuddyAliasMessageDetail(input: {
  creds: WorkBuddyTokenCredentials;
  aliasId: string;
  messageId: string;
  allowLoopback?: boolean;
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>;
}): Promise<WorkBuddyMessageDetail> {
  const resp = await requestWorkBuddyGateway({
    creds: input.creds,
    method: "GET",
    relPath: `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(input.aliasId)}/messages/${encodeURIComponent(input.messageId)}`,
    allowLoopback: input.allowLoopback,
    onRefreshed: input.onRefreshed,
  });
  mapWorkBuddyRestError(resp.status, resp.body);
  const data = (unwrapWorkBuddyEnvelope(resp.body).data ?? {}) as Record<string, unknown>;
  const bodyFormat = String(data.body_format ?? "TEXT").toUpperCase() === "HTML" ? "HTML" : "TEXT";
  const rawBody = String(data.body ?? "");
  const safe = bodyFormat === "HTML" ? sanitizeSafeMailHtml(rawBody, { allowRemoteImages: false }) : null;
  const plainText = safe
    ? safe.html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    : rawBody;
  const attachments = (Array.isArray(data.attachments) ? data.attachments : [])
    .map((att) => {
      const a = att as Record<string, unknown>;
      return {
        attachmentId: String(a.attachment_id ?? "").trim(),
        filename: String(a.filename ?? "attachment.bin").replace(/[\\/\r\n\0]/g, "_"),
        size: Number(a.size ?? 0),
        contentType: String(a.content_type ?? "application/octet-stream").trim(),
      };
    })
    .filter((a) => a.attachmentId.length > 0);
  return {
    messageId: String(data.message_id ?? input.messageId).trim(),
    subject: String(data.subject ?? "").trim(),
    from: parseAddress(data.from),
    to: parseAddressList(data.to),
    cc: parseAddressList(data.cc),
    createdAt: String(data.created_at ?? ""),
    isRead: Boolean(data.is_read),
    bodyFormat,
    sanitizedHtml: safe ? safe.html : "",
    plainText,
    hasRemoteImages: safe ? safe.hasRemoteImages : false,
    attachments,
    dailyQuota: resp.quota,
  };
}

export async function deleteWorkBuddyAliasMessage(input: {
  creds: WorkBuddyTokenCredentials;
  aliasId: string;
  messageId: string;
  confirmationToken?: string;
  allowLoopback?: boolean;
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>;
}): Promise<{ messageId: string; needsConfirmation: boolean; confirmationToken?: string; deleted: boolean; dailyQuota: WorkBuddyDailyQuota }> {
  const query = input.confirmationToken?.trim()
    ? { confirmation_token: input.confirmationToken.trim() }
    : undefined;
  const resp = await requestWorkBuddyGateway({
    creds: input.creds,
    method: "DELETE",
    relPath: `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(input.aliasId)}/messages/${encodeURIComponent(input.messageId)}`,
    query,
    allowLoopback: input.allowLoopback,
    onRefreshed: input.onRefreshed,
  });
  if (!input.confirmationToken?.trim()) {
    const errDetails = (resp.body as { error?: { code?: string; details?: { confirmation_token?: string } } })?.error;
    const directTok = (unwrapWorkBuddyEnvelope(resp.body).data as { confirmation_token?: string } | undefined)?.confirmation_token;
    const token = (
      (errDetails?.code === "CONFIRMATION_REQUIRED" ? errDetails.details?.confirmation_token : undefined) ||
      directTok ||
      ""
    ).trim();
    if (token) {
      return {
        messageId: input.messageId,
        needsConfirmation: true,
        confirmationToken: token,
        deleted: false,
        dailyQuota: resp.quota,
      };
    }
  }
  mapWorkBuddyRestError(resp.status, resp.body);
  return { messageId: input.messageId, needsConfirmation: false, deleted: true, dailyQuota: resp.quota };
}

export async function downloadWorkBuddyAliasAttachment(input: {
  creds: WorkBuddyTokenCredentials;
  aliasId: string;
  messageId: string;
  attachmentId: string;
  allowLoopback?: boolean;
  onRefreshed?: (next: WorkBuddyTokenCredentials) => Promise<void>;
}): Promise<{ filename: string; contentType: string; bytes: Uint8Array }> {
  const resp = await requestWorkBuddyGateway({
    creds: input.creds,
    method: "GET",
    relPath: `/console/agent-gateway/agentmailrest/v1/aliases/${encodeURIComponent(input.aliasId)}/messages/${encodeURIComponent(input.messageId)}/attachments/${encodeURIComponent(input.attachmentId)}`,
    maxBytes: MAX_ATTACHMENT_JSON_BYTES,
    allowLoopback: input.allowLoopback,
    onRefreshed: input.onRefreshed,
  });
  mapWorkBuddyRestError(resp.status, resp.body);
  const raw = (unwrapWorkBuddyEnvelope(resp.body).data ?? {}) as {
    content?: string;
    filename?: string;
    content_type?: string;
  };
  let clean = (raw.content ?? "").trim();
  const sep = clean.indexOf(";base64,");
  if (sep >= 0) clean = clean.slice(sep + 8);
  clean = clean.replace(/[\r\n\s]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (clean.length % 4 !== 0) clean += "=";
  let binary: string;
  try {
    binary = atob(clean);
  } catch {
    throw new HttpError(502, "workbuddy_gateway_failed");
  }
  if (binary.length > MAX_ATTACHMENT_DECODED_BYTES) {
    throw new HttpError(413, "workbuddy_attachment_too_large");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return {
    filename: (raw.filename ?? "attachment.bin").replace(/[\\/\r\n\0"]/g, "_"),
    contentType: (raw.content_type ?? "application/octet-stream").trim() || "application/octet-stream",
    bytes,
  };
}
