import type { CodeSource } from "../../domain/models.js";
import { computeNewsletterSubscriptionId } from "../../domain/mail-extensions.js";
import type {
  MailMessageClassification,
  MailMessageDetail,
  MailMessageLifecycleState,
  MailMessageSourceKind,
  MailMessageSummary,
  MailVerificationAccountScope,
  MailVerificationRecord,
} from "../../domain/mail-message.js";
import { sanitizeMailHtml } from "../../service/mail-html-sanitizer.js";

export interface RawMailMessageRow {
  id: string;
  rfc_message_id: string | null;
  thread_key: string | null;
  subject: string;
  from_address: string;
  from_name: string | null;
  snippet: string;
  body_text: string | null;
  body_html: string | null;
  body_cache_state: "none" | "cached";
  has_attachments: number;
  classification: MailMessageClassification;
  newsletter_list_id: string | null;
  observed_at: string;
  version: number;
  source_kind: MailMessageSourceKind;
  source_ref_id: string;
  account_id: string | null;
  session_id: string | null;
  provider_instance_id: string | null;
  external_message_id: string | null;
  received_address: string;
  provider_label: string;
  lifecycle_state: MailMessageLifecycleState;
  is_read: number;
  is_starred: number;
  is_archived: number;
  is_important: number;
  local_folder: string;
  labels_json: string;
  draft_cc_json: string;
  draft_bcc_json: string;
}

export interface RawMailVerificationRow {
  id: string;
  message_id: string;
  session_id: string | null;
  source_ref_id: string;
  account_scope: MailVerificationAccountScope;
  received_address: string;
  code: string;
  code_source: CodeSource;
  candidates_json: string;
  issuer_hint: string | null;
  target_service_hint: string | null;
  confidence: number;
  expires_at: string | null;
  extracted_at: string;
  subject: string;
  from_address: string;
  observed_at: string;
}

export function parseStringArrayJson(rawJson: string | null | undefined): string[] {
  if (!rawJson) {
    return [];
  }
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function mapMailMessageSummaryRow(row: RawMailMessageRow): MailMessageSummary {
  const labels = parseStringArrayJson(row.labels_json);
  const isNewsletter =
    row.classification === "newsletter"
    || labels.some((label) => label.toLowerCase() === "newsletters");
  const newsletterSubscriptionId = isNewsletter
    ? computeNewsletterSubscriptionId(row.newsletter_list_id, row.from_address)
    : undefined;

  return {
    id: row.id,
    ...(row.account_id ? { accountId: row.account_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    sourceRefId: row.source_ref_id,
    sourceKind: row.source_kind,
    ...(row.provider_instance_id ? { providerInstanceId: row.provider_instance_id } : {}),
    ...(row.external_message_id ? { externalMessageId: row.external_message_id } : {}),
    ...(row.rfc_message_id ? { rfcMessageId: row.rfc_message_id } : {}),
    ...(row.thread_key ? { threadKey: row.thread_key } : {}),
    receivedAddress: row.received_address,
    providerLabel: row.provider_label,
    subject: row.subject,
    fromAddress: row.from_address,
    ...(row.from_name ? { fromName: row.from_name } : {}),
    snippet: row.snippet,
    hasAttachments: row.has_attachments === 1,
    classification: row.classification,
    lifecycleState: row.lifecycle_state,
    observedAt: row.observed_at,
    isRead: row.is_read === 1,
    isStarred: row.is_starred === 1,
    isArchived: row.is_archived === 1,
    isImportant: row.is_important === 1,
    localFolder: row.local_folder,
    labels,
    ...(newsletterSubscriptionId ? { newsletterSubscriptionId } : {}),
    version: row.version,
  };
}

export function mapMailMessageDetailRow(
  row: RawMailMessageRow,
): { detail: MailMessageDetail; rawBodyHtml?: string } {
  const summary = mapMailMessageSummaryRow(row);
  const rawBodyHtml = row.body_html ?? undefined;
  const sanitizedBodyHtml = sanitizeMailHtml(rawBodyHtml);
  return {
    detail: {
      ...summary,
      ...(row.body_text !== null ? { bodyText: row.body_text } : {}),
      ...(sanitizedBodyHtml !== undefined ? { bodyHtml: sanitizedBodyHtml } : {}),
      rawHtmlAvailable: Boolean(rawBodyHtml),
      bodyCacheState: row.body_cache_state,
      draftCcAddresses: parseStringArrayJson(row.draft_cc_json),
      draftBccAddresses: parseStringArrayJson(row.draft_bcc_json),
    },
    ...(rawBodyHtml !== undefined ? { rawBodyHtml } : {}),
  };
}

export function mapMailVerificationRow(
  row: RawMailVerificationRow,
  nowMs: number,
): MailVerificationRecord {
  const expiresMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  const isFresh = Number.isFinite(expiresMs)
    ? expiresMs >= nowMs
    : (() => {
        const observedMs = Date.parse(row.observed_at);
        return Number.isFinite(observedMs) && nowMs - observedMs <= 15 * 60 * 1000;
      })();

  return {
    id: row.id,
    messageId: row.message_id,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    sourceRefId: row.source_ref_id,
    accountScope: row.account_scope,
    receivedAddress: row.received_address,
    code: row.code,
    codeSource: row.code_source,
    candidates: parseStringArrayJson(row.candidates_json),
    ...(row.issuer_hint ? { issuerHint: row.issuer_hint } : {}),
    ...(row.target_service_hint ? { targetServiceHint: row.target_service_hint } : {}),
    confidence: row.confidence,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    isFresh,
    extractedAt: row.extracted_at,
    subject: row.subject,
    fromAddress: row.from_address,
    observedAt: row.observed_at,
  };
}
