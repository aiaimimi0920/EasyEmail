import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type {
  MailMessageClassification,
  MailMessageLifecycleState,
  MailMessageSourceKind,
  MailVerificationAccountScope,
} from "../../domain/mail-message.js";
import type { MappedLegacyAccount } from "./legacy-account-mapper.js";
import {
  readAndMapLegacyDeliveryAndAgentDomains,
  type MappedLegacyAgentMessage,
  type MappedLegacyAgentService,
  type MappedLegacyAgentThread,
  type MappedLegacySendQueueItem,
} from "./legacy-delivery-agent-mappers.js";

export type {
  MappedLegacyAgentMessage,
  MappedLegacyAgentService,
  MappedLegacyAgentThread,
  MappedLegacySendQueueItem,
};

export interface LegacyMessageSampleHash {
  messageId: string;
  sha256: string;
}

export interface MappedLegacyMessage {
  id: string;
  rfcMessageId: string | null;
  threadKey: string | null;
  subject: string;
  fromAddress: string;
  fromName: string | null;
  snippet: string;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyCacheState: "none" | "cached";
  hasAttachments: boolean;
  classification: MailMessageClassification;
  newsletterListId: string | null;
  newsletterUnsubscribeJson: string;
  observedAt: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

export interface MappedLegacyMessageSource {
  id: string;
  messageId: string;
  sourceKind: MailMessageSourceKind;
  sourceRefId: string;
  accountId: string | null;
  sessionId: string | null;
  providerInstanceId: string | null;
  externalMessageId: string | null;
  receivedAddress: string;
  providerLabel: string;
  lifecycleState: MailMessageLifecycleState;
  isRead: boolean;
  isStarred: boolean;
  isArchived: boolean;
  isImportant: boolean;
  localFolder: string;
  labelsJson: string;
  draftCcJson: string;
  draftBccJson: string;
  legacyFolderId: string | null;
  imapUid: string | null;
  imapUidValidity: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface MappedLegacyVerificationCode {
  id: string;
  messageId: string;
  sessionId: string | null;
  sourceRefId: string;
  accountScope: MailVerificationAccountScope;
  receivedAddress: string;
  code: string;
  codeSource: "subject" | "text" | "html";
  candidatesJson: string;
  issuerHint: string | null;
  targetServiceHint: string | null;
  confidence: number;
  expiresAt: string | null;
  extractedAt: string;
}

export interface MappedLegacyNewsletterOverride {
  accountId: string;
  subscriptionKey: string;
  hidden: boolean;
  updatedAt: string;
}

export interface MappedLegacyMailActivityDomains {
  messages: MappedLegacyMessage[];
  messageSources: MappedLegacyMessageSource[];
  messageSampleHashes: LegacyMessageSampleHash[];
  verificationCodes: MappedLegacyVerificationCode[];
  newsletterOverrides: MappedLegacyNewsletterOverride[];
  sendQueueItems: MappedLegacySendQueueItem[];
  agentServices: MappedLegacyAgentService[];
  agentThreads: MappedLegacyAgentThread[];
  agentMessages: MappedLegacyAgentMessage[];
}

export function computeCanonicalMessageSampleHash(input: {
  id: string;
  rfcMessageId: string | null;
  subject: string;
  fromAddress: string;
  bodyText: string | null;
  bodyHtml: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([
      input.id,
      input.rfcMessageId ?? null,
      input.subject,
      input.fromAddress,
      input.bodyText ?? null,
      input.bodyHtml ?? null,
    ]), "utf8")
    .digest("hex");
}

function assertIso(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} timestamp is invalid.`);
  }
  return new Date(Date.parse(trimmed)).toISOString();
}

function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parseStringArrayJson(value: unknown): string[] {
  if (typeof value === "string") {
    try {
      return parseStringArrayJson(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

export function readAndMapLegacyMailActivityDomains(
  sourceDb: DatabaseSync,
  existingTables: ReadonlySet<string>,
  accountsById: ReadonlyMap<string, MappedLegacyAccount>,
): MappedLegacyMailActivityDomains {
  const mailboxSourceKindById = new Map<string, { kind: string; providerId: string | null; address: string | null }>();
  if (existingTables.has("mailbox_sources")) {
    const rows = sourceDb.prepare(
      "SELECT id, source_kind, provider_id, address FROM mailbox_sources",
    ).all() as Array<{ id: string; source_kind: string; provider_id: string | null; address: string | null }>;
    for (const row of rows) {
      mailboxSourceKindById.set(row.id, {
        kind: row.source_kind.trim().toLowerCase(),
        providerId: row.provider_id,
        address: row.address,
      });
    }
  }

  const agentLinkedMessageIds = new Set<string>();
  if (existingTables.has("agent_messages")) {
    const rows = sourceDb.prepare("SELECT message_id FROM agent_messages").all() as Array<{ message_id: string }>;
    for (const row of rows) agentLinkedMessageIds.add(row.message_id);
  }

  const messageSourcesByMessageId = new Map<string, MappedLegacyMessageSource[]>();
  const messageSources: MappedLegacyMessageSource[] = [];
  if (existingTables.has("message_sources")) {
    const rows = sourceDb.prepare(`
      SELECT id, message_id, source_id, account_id, folder_id, temp_mailbox_id,
             provider_message_id, imap_uid, imap_uidvalidity, easyemail_message_id,
             received_address, flags_json, first_seen_at, last_seen_at
      FROM message_sources ORDER BY first_seen_at ASC, id ASC
    `).all() as Array<{
      id: string; message_id: string; source_id: string; account_id: string | null;
      folder_id: string | null; temp_mailbox_id: string | null; provider_message_id: string | null;
      imap_uid: string | null; imap_uidvalidity: string | null; easyemail_message_id: string | null;
      received_address: string | null; flags_json: string; first_seen_at: string; last_seen_at: string;
    }>;

    for (const row of rows) {
      const flags = parseJsonObject(row.flags_json);
      const sourceMeta = mailboxSourceKindById.get(row.source_id);
      const account = row.account_id ? accountsById.get(row.account_id) : undefined;
      const localFolder = typeof flags.local_folder === "string" && flags.local_folder.trim()
        ? flags.local_folder.trim()
        : "inbox";
      let sourceKind: MailMessageSourceKind = "imap";
      if (row.temp_mailbox_id || sourceMeta?.kind === "easyemail" || sourceMeta?.kind === "temp_mailbox") {
        sourceKind = "temporary_session";
      } else if (sourceMeta?.kind === "local_draft" || (localFolder === "drafts" && !row.imap_uid)) {
        sourceKind = "local_draft";
      } else if (sourceMeta?.kind === "smtp" || sourceMeta?.kind === "outgoing") {
        sourceKind = "smtp";
      } else if (sourceMeta?.kind === "agent") {
        sourceKind = "agent";
      }

      const lifecycleState: MailMessageLifecycleState = sourceKind === "local_draft"
        ? "draft"
        : account?.status === "history_only"
          ? "history_only"
          : "active";
      const externalMessageId = sourceKind === "temporary_session"
        ? (row.easyemail_message_id ?? row.provider_message_id ?? row.id)
        : sourceKind === "imap"
          ? (row.provider_message_id ?? (row.imap_uid ? `${row.folder_id ?? "inbox"}:${row.imap_uid}` : row.id))
          : (row.provider_message_id ?? null);

      const mappedSource: MappedLegacyMessageSource = {
        id: row.id.trim(),
        messageId: row.message_id.trim(),
        sourceKind,
        sourceRefId: row.source_id.trim() || row.id.trim(),
        accountId: account ? account.id : null,
        sessionId: row.temp_mailbox_id?.trim() || null,
        providerInstanceId: sourceMeta?.providerId?.trim() || null,
        externalMessageId,
        receivedAddress: (row.received_address ?? account?.primaryAddress ?? sourceMeta?.address ?? "unknown@legacy.local").trim().toLowerCase(),
        providerLabel: account?.providerLabel ?? sourceMeta?.providerId ?? "Legacy Import",
        lifecycleState,
        isRead: flags.read === true,
        isStarred: flags.starred === true,
        isArchived: flags.archived === true,
        isImportant: flags.important === true,
        localFolder,
        labelsJson: JSON.stringify(parseStringArrayJson(flags.labels)),
        draftCcJson: JSON.stringify(parseStringArrayJson(flags.cc_addresses ?? flags.draft_cc)),
        draftBccJson: JSON.stringify(parseStringArrayJson(flags.bcc_addresses ?? flags.draft_bcc)),
        legacyFolderId: row.folder_id?.trim() || null,
        imapUid: row.imap_uid?.trim() || null,
        imapUidValidity: row.imap_uidvalidity?.trim() || null,
        firstSeenAt: assertIso(row.first_seen_at, "message_source.first_seen_at"),
        lastSeenAt: assertIso(row.last_seen_at, "message_source.last_seen_at"),
      };
      messageSources.push(mappedSource);
      const group = messageSourcesByMessageId.get(mappedSource.messageId);
      if (group) group.push(mappedSource);
      else messageSourcesByMessageId.set(mappedSource.messageId, [mappedSource]);
    }
  }

  const messages: MappedLegacyMessage[] = [];
  if (existingTables.has("messages")) {
    const rows = sourceDb.prepare(`
      SELECT id, rfc_message_id, thread_key, subject, from_address, from_name,
             date_sent, date_received, snippet, body_text_cache, body_html_cache,
             body_cache_state, has_attachments, classification, security_flags,
             created_at, updated_at, deleted_at
      FROM messages ORDER BY created_at ASC, id ASC
    `).all() as Array<{
      id: string; rfc_message_id: string | null; thread_key: string | null;
      subject: string; from_address: string; from_name: string | null;
      date_sent: string | null; date_received: string | null; snippet: string;
      body_text_cache: string | null; body_html_cache: string | null; body_cache_state: string;
      has_attachments: number; classification: string; security_flags: string;
      created_at: string; updated_at: string; deleted_at: string | null;
    }>;

    for (const row of rows) {
      const id = row.id.trim();
      const linkedSources = messageSourcesByMessageId.get(id) ?? [];
      if (linkedSources.length === 0) {
        const createdIso = assertIso(row.created_at, "message.created_at");
        const syntheticSource: MappedLegacyMessageSource = {
          id: `msrc_legacy_${id}`,
          messageId: id,
          sourceKind: "local_draft",
          sourceRefId: `legacy_orphan_${id}`,
          accountId: null,
          sessionId: null,
          providerInstanceId: null,
          externalMessageId: null,
          receivedAddress: row.from_address.trim().toLowerCase() || "unknown@legacy.local",
          providerLabel: "Legacy Import",
          lifecycleState: "history_only",
          isRead: true,
          isStarred: false,
          isArchived: false,
          isImportant: false,
          localFolder: "inbox",
          labelsJson: "[]",
          draftCcJson: "[]",
          draftBccJson: "[]",
          legacyFolderId: null,
          imapUid: null,
          imapUidValidity: null,
          firstSeenAt: createdIso,
          lastSeenAt: createdIso,
        };
        messageSources.push(syntheticSource);
        messageSourcesByMessageId.set(id, [syntheticSource]);
      }

      const secFlags = parseJsonObject(row.security_flags);
      const rawClass = row.classification.trim().toLowerCase();
      const onlyAgentAccounts = linkedSources.length > 0
        && linkedSources.every((src) => src.accountId && accountsById.get(src.accountId)?.scope === "agent");
      let classification: MailMessageClassification = "general";
      if (rawClass === "agent" || agentLinkedMessageIds.has(id) || onlyAgentAccounts) {
        classification = "agent";
      } else if (rawClass === "verification") {
        classification = "verification";
      } else if (rawClass === "newsletter") {
        classification = "newsletter";
      } else if (
        rawClass === "outgoing"
        || linkedSources.some((src) => src.sourceKind === "smtp" || src.sourceKind === "local_draft")
      ) {
        classification = "outgoing";
      }

      const hasCachedBody = row.body_text_cache !== null
        || row.body_html_cache !== null
        || row.body_cache_state === "cached"
        || row.body_cache_state === "full";
      const observedRaw = row.date_received ?? row.date_sent ?? row.created_at;
      const observedAt = Number.isNaN(Date.parse(observedRaw))
        ? assertIso(row.created_at, "message.created_at")
        : new Date(Date.parse(observedRaw)).toISOString();

      messages.push({
        id,
        rfcMessageId: row.rfc_message_id?.trim() || null,
        threadKey: row.thread_key?.trim() || null,
        subject: row.subject ?? "",
        fromAddress: row.from_address.trim() || "unknown@legacy.local",
        fromName: row.from_name?.trim() || null,
        snippet: row.snippet ?? "",
        bodyText: row.body_text_cache ?? null,
        bodyHtml: row.body_html_cache ?? null,
        bodyCacheState: hasCachedBody ? "cached" : "none",
        hasAttachments: row.has_attachments === 1,
        classification,
        newsletterListId: typeof secFlags.list_id === "string" && secFlags.list_id.trim()
          ? secFlags.list_id.trim()
          : null,
        newsletterUnsubscribeJson: JSON.stringify(parseStringArrayJson(secFlags.unsubscribe_methods ?? secFlags.list_unsubscribe)),
        observedAt,
        createdAt: assertIso(row.created_at, "message.created_at"),
        updatedAt: assertIso(row.updated_at, "message.updated_at"),
        deletedAt: row.deleted_at ? assertIso(row.deleted_at, "message.deleted_at") : null,
      });
    }
  }

  const liveMessages = messages.filter((msg) => msg.deletedAt === null);
  const sampleStep = Math.max(1, Math.floor(liveMessages.length / 16));
  const messageSampleHashes: LegacyMessageSampleHash[] = liveMessages
    .filter((_, idx) => idx % sampleStep === 0)
    .slice(0, 16)
    .map((msg) => ({
      messageId: msg.id,
      sha256: computeCanonicalMessageSampleHash({
        id: msg.id,
        rfcMessageId: msg.rfcMessageId,
        subject: msg.subject,
        fromAddress: msg.fromAddress,
        bodyText: msg.bodyText,
        bodyHtml: msg.bodyHtml,
      }),
    }));

  const messageIds = new Set(messages.map((item) => item.id));
  const verificationCodes: MappedLegacyVerificationCode[] = existingTables.has("verification_codes")
    ? (sourceDb.prepare(`
        SELECT id, message_id, account_scope, received_address, code,
               issuer_hint, target_service_hint, confidence, expires_at, extracted_at
        FROM verification_codes ORDER BY extracted_at ASC, id ASC
      `).all() as Array<{
        id: string; message_id: string; account_scope: string; received_address: string;
        code: string; issuer_hint: string | null; target_service_hint: string | null;
        confidence: number; expires_at: string | null; extracted_at: string;
      }>)
      .filter((row) => messageIds.has(row.message_id) && row.code.trim().length > 0)
      .map((row) => {
        const primarySource = messageSourcesByMessageId.get(row.message_id)?.[0];
        const rawScope = row.account_scope.trim().toLowerCase();
        const accountScope: MailVerificationAccountScope =
          rawScope === "normal" || rawScope === "promoted" || rawScope === "agent"
            ? rawScope
            : "anonymous";
        const clampedConfidence = Number.isFinite(row.confidence)
          ? Math.min(1, Math.max(0, row.confidence))
          : 0.8;
        return {
          id: row.id.trim(),
          messageId: row.message_id.trim(),
          sessionId: primarySource?.sessionId ?? null,
          sourceRefId: primarySource?.sourceRefId ?? `legacy_verif_${row.id.trim()}`,
          accountScope,
          receivedAddress: row.received_address.trim().toLowerCase(),
          code: row.code.trim(),
          codeSource: "text",
          candidatesJson: JSON.stringify([row.code.trim()]),
          issuerHint: row.issuer_hint?.trim() || null,
          targetServiceHint: row.target_service_hint?.trim() || null,
          confidence: clampedConfidence,
          expiresAt: row.expires_at ? assertIso(row.expires_at, "verification_code.expires_at") : null,
          extractedAt: assertIso(row.extracted_at, "verification_code.extracted_at"),
        };
      })
    : [];

  const newsletterOverrides: MappedLegacyNewsletterOverride[] =
    existingTables.has("newsletter_subscription_overrides")
      ? (sourceDb.prepare(`
          SELECT account_id, subscription_key, hidden, updated_at
          FROM newsletter_subscription_overrides ORDER BY updated_at ASC
        `).all() as Array<{
          account_id: string; subscription_key: string; hidden: number; updated_at: string;
        }>)
        .filter((row) => accountsById.has(row.account_id) && row.subscription_key.trim().length > 0)
        .map((row) => ({
          accountId: row.account_id,
          subscriptionKey: row.subscription_key.trim(),
          hidden: row.hidden === 1,
          updatedAt: assertIso(row.updated_at, "newsletter_override.updated_at"),
        }))
      : [];

  const deliveryAndAgent = readAndMapLegacyDeliveryAndAgentDomains(
    sourceDb,
    existingTables,
    accountsById,
    messageIds,
  );

  return {
    messages,
    messageSources,
    messageSampleHashes,
    verificationCodes,
    newsletterOverrides,
    ...deliveryAndAgent,
  };
}
