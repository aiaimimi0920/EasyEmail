import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type { MailAvatarSettings } from "../../domain/mail-avatar.js";
import type { MailAccountSyncState, MailImapFolderKind } from "../../domain/mail-imap-sync.js";
import type { MailboxSession } from "../../domain/mailbox-models.js";
import {
  CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY,
  normalizeMailProviderTypeKey,
} from "../../domain/provider-taxonomy.js";
import { normalizeDisplayName, normalizeEmail } from "../../service/account-validation.js";
import { validateSafeSvgBytes } from "../../service/avatar-network.js";

const ALLOWED_IMAP_FOLDER_KINDS = new Set<MailImapFolderKind>([
  "inbox", "archive", "spam", "trash", "sent", "drafts", "mail",
]);
const ALLOWED_AVATAR_MIMES = new Set([
  "image/png", "image/jpeg", "image/x-icon", "image/svg+xml",
]);
const MAX_CONTACT_OVERRIDE_BYTES = 512 * 1024;
const MAX_CACHED_AVATAR_BYTES = 256 * 1024;

export interface MappedLegacyContact {
  id: string;
  displayName: string;
  emailAddress: string;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappedLegacyTaxonomyItem {
  id: string;
  kind: "folder" | "label";
  name: string;
  normalizedName: string;
  parentId: string | null;
  color: string;
  sortOrder: number;
  system: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MappedLegacyImapFolder {
  id: string;
  accountId: string;
  sourceRefId: string;
  providerFolderId: string;
  displayName: string;
  path: string;
  delimiter: string;
  folderKind: MailImapFolderKind;
  lastSeenUid: string | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MappedLegacySyncCheckpoint {
  accountId: string;
  syncState: MailAccountSyncState;
  lastAttemptAt: string | null;
  lastSyncedAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  updatedAt: string;
}

export interface MappedLegacyAvatarSettings extends MailAvatarSettings {
  updatedAt: string;
}

export interface MappedLegacyAvatarCacheEntry {
  cacheKey: string;
  senderDomain: string;
  normalizedSender: string;
  sourceKind: string;
  imageMime: string | null;
  imageBytes: Uint8Array | null;
  remoteUrl: string | null;
  fallbackText: string;
  status: "ok" | "failed";
  authJson: string;
  lastError: string | null;
  fetchedAt: string;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MappedLegacyContactAvatarOverride {
  senderKey: string;
  normalizedSender: string;
  senderDomain: string;
  imageMime: string;
  imageBytes: Uint8Array;
  displayName: string;
  createdAt: string;
  updatedAt: string;
}

export interface MappedLegacyCatalogDomains {
  tempSessions: MailboxSession[];
  contacts: MappedLegacyContact[];
  taxonomyItems: MappedLegacyTaxonomyItem[];
  imapFolders: MappedLegacyImapFolder[];
  syncCheckpoints: MappedLegacySyncCheckpoint[];
  easyEmailServiceUrl: string | null;
  avatarSettings: MappedLegacyAvatarSettings | null;
  avatarCacheEntries: MappedLegacyAvatarCacheEntry[];
  contactAvatarOverrides: MappedLegacyContactAvatarOverride[];
}

function assertSafeId(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 256 || !/^[A-Za-z0-9._:@/-]+$/.test(trimmed)) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} is invalid.`);
  }
  return trimmed;
}

function assertIso(value: string, field: string): string {
  const trimmed = value.trim();
  if (!trimmed || Number.isNaN(Date.parse(trimmed))) {
    throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy ${field} timestamp is invalid.`);
  }
  return new Date(Date.parse(trimmed)).toISOString();
}

function hasColumn(sourceDb: DatabaseSync, tableName: string, columnName: string): boolean {
  const rows = sourceDb.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function sanitizeEasyEmailServiceUrl(rawValueJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValueJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rawUrl = (parsed as Record<string, unknown>).service_url;
  if (typeof rawUrl !== "string" || !rawUrl.trim()) return null;
  try {
    const url = new URL(rawUrl.trim());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

function normalizeImapFolderKind(raw: string): MailImapFolderKind {
  const normalized = raw.trim().toLowerCase();
  if (ALLOWED_IMAP_FOLDER_KINDS.has(normalized as MailImapFolderKind)) {
    return normalized as MailImapFolderKind;
  }
  if (normalized === "junk") return "spam";
  if (normalized === "deleted") return "trash";
  return "mail";
}

function mapTempMailboxes(
  sourceDb: DatabaseSync,
  existingTables: ReadonlySet<string>,
  importedAccountIds: ReadonlySet<string>,
  defaultHostId: string,
): MailboxSession[] {
  if (!existingTables.has("temp_mailboxes")) return [];
  const rows = sourceDb.prepare(`
    SELECT id, email_address, provider_id, provider_label, easyemail_mailbox_id,
           visibility_state, lifecycle_state, lease_expires_at, upgraded_account_id,
           created_at, updated_at, archived_at
    FROM temp_mailboxes
    ORDER BY created_at ASC, id ASC
  `).all() as Array<{
    id: string;
    email_address: string;
    provider_id: string;
    provider_label: string;
    easyemail_mailbox_id: string | null;
    visibility_state: string;
    lifecycle_state: string;
    lease_expires_at: string | null;
    upgraded_account_id: string | null;
    created_at: string;
    updated_at: string;
    archived_at: string | null;
  }>;

  return rows.map((row) => {
    const id = assertSafeId(row.id, "temp_mailbox.id");
    const emailAddress = normalizeEmail(row.email_address);
    if (!emailAddress) {
      throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy temp_mailbox ${id} has invalid email.`);
    }
    const providerTypeKey = normalizeMailProviderTypeKey(row.provider_id)
      ?? CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY;
    const providerInstanceId = `${providerTypeKey}-default`;
    const active = row.lifecycle_state === "active" || row.lifecycle_state === "expiring";
    const metadata: Record<string, string> = {
      visibilityState: row.visibility_state.trim() || "anonymous",
      lifecycleState: row.lifecycle_state.trim() || "history_only",
      providerLabel: row.provider_label.trim() || providerTypeKey,
      legacyImported: "true",
      updatedAt: assertIso(row.updated_at, "temp_mailbox.updated_at"),
    };
    if (row.upgraded_account_id && importedAccountIds.has(row.upgraded_account_id.trim())) {
      metadata.upgradedAccountId = row.upgraded_account_id.trim();
    }
    if (row.archived_at) {
      metadata.releasedAt = assertIso(row.archived_at, "temp_mailbox.archived_at");
    }
    return {
      id,
      hostId: defaultHostId,
      providerTypeKey,
      providerInstanceId,
      emailAddress,
      mailboxRef: row.easyemail_mailbox_id?.trim() || id,
      status: active && !row.archived_at ? "open" : "expired",
      createdAt: assertIso(row.created_at, "temp_mailbox.created_at"),
      expiresAt: row.lease_expires_at ? assertIso(row.lease_expires_at, "temp_mailbox.lease_expires_at") : undefined,
      metadata,
    };
  });
}

function orderTaxonomyParentFirst(items: MappedLegacyTaxonomyItem[]): MappedLegacyTaxonomyItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const ordered: MappedLegacyTaxonomyItem[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();

  const visit = (item: MappedLegacyTaxonomyItem): void => {
    if (visited.has(item.id)) return;
    if (visiting.has(item.id)) {
      item.parentId = null;
      return;
    }
    visiting.add(item.id);
    if (item.parentId) {
      const parent = byId.get(item.parentId);
      if (!parent || parent.kind !== item.kind) {
        item.parentId = null;
      } else {
        visit(parent);
      }
    }
    visiting.delete(item.id);
    visited.add(item.id);
    ordered.push(item);
  };

  for (const item of items) visit(item);
  return ordered;
}

export function readAndMapLegacyCatalogDomains(
  sourceDb: DatabaseSync,
  existingTables: ReadonlySet<string>,
  importedAccountIds: ReadonlySet<string>,
  defaultHostId = "legacy-easyemailam-host",
): MappedLegacyCatalogDomains {
  const tempSessions = mapTempMailboxes(sourceDb, existingTables, importedAccountIds, defaultHostId);

  const contacts: MappedLegacyContact[] = existingTables.has("contacts")
    ? (sourceDb.prepare(`
        SELECT id, display_name, email_address, note, created_at, updated_at
        FROM contacts ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string; display_name: string; email_address: string;
        note: string | null; created_at: string; updated_at: string;
      }>).map((row) => {
        const emailAddress = normalizeEmail(row.email_address);
        if (!emailAddress) {
          throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy contact ${row.id} has invalid email.`);
        }
        return {
          id: assertSafeId(row.id, "contact.id"),
          displayName: normalizeDisplayName(row.display_name || emailAddress),
          emailAddress,
          note: row.note?.trim() ? row.note.trim() : null,
          createdAt: assertIso(row.created_at, "contact.created_at"),
          updatedAt: assertIso(row.updated_at, "contact.updated_at"),
        };
      })
    : [];

  let taxonomyItems: MappedLegacyTaxonomyItem[] = [];
  if (existingTables.has("mail_taxonomy_items")) {
    const withParent = hasColumn(sourceDb, "mail_taxonomy_items", "parent_id");
    const rows = sourceDb.prepare(`
      SELECT id, kind, name, normalized_name, ${withParent ? "parent_id" : "NULL AS parent_id"},
             color, sort_order, system, created_at, updated_at
      FROM mail_taxonomy_items ORDER BY sort_order ASC, created_at ASC, id ASC
    `).all() as Array<{
      id: string; kind: string; name: string; normalized_name: string; parent_id: string | null;
      color: string; sort_order: number; system: number; created_at: string; updated_at: string;
    }>;
    taxonomyItems = orderTaxonomyParentFirst(rows.map((row) => {
      if (row.kind !== "folder" && row.kind !== "label") {
        throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy taxonomy ${row.id} has invalid kind.`);
      }
      const name = row.name.trim();
      if (!name) {
        throw new EasyEmailError("LEGACY_IMPORT_INVALID_RECORD", `Legacy taxonomy ${row.id} has empty name.`);
      }
      return {
        id: assertSafeId(row.id, "taxonomy.id"),
        kind: row.kind,
        name,
        normalizedName: (row.normalized_name || name).trim().toLowerCase(),
        parentId: row.parent_id ? assertSafeId(row.parent_id, "taxonomy.parent_id") : null,
        color: row.color.trim() || "#06b6d4",
        sortOrder: Number.isSafeInteger(row.sort_order) ? row.sort_order : 0,
        system: row.system === 1,
        createdAt: assertIso(row.created_at, "taxonomy.created_at"),
        updatedAt: assertIso(row.updated_at, "taxonomy.updated_at"),
      };
    }));
  }

  const imapFolders: MappedLegacyImapFolder[] = existingTables.has("mail_folders")
    ? (sourceDb.prepare(`
        SELECT id, account_id, source_id, provider_folder_id, display_name, path, delimiter,
               folder_kind, last_seen_uid, created_at, updated_at
        FROM mail_folders ORDER BY created_at ASC, id ASC
      `).all() as Array<{
        id: string; account_id: string; source_id: string; provider_folder_id: string;
        display_name: string; path: string; delimiter: string | null; folder_kind: string;
        last_seen_uid: string | null; created_at: string; updated_at: string;
      }>)
      .filter((row) => importedAccountIds.has(row.account_id))
      .map((row) => ({
        id: assertSafeId(row.id, "mail_folder.id"),
        accountId: row.account_id,
        sourceRefId: assertSafeId(row.source_id, "mail_folder.source_id"),
        providerFolderId: row.provider_folder_id.trim() || row.path.trim() || "INBOX",
        displayName: row.display_name.trim() || "INBOX",
        path: row.path.trim() || "INBOX",
        delimiter: row.delimiter?.trim() || "/",
        folderKind: normalizeImapFolderKind(row.folder_kind),
        lastSeenUid: row.last_seen_uid?.trim() || null,
        lastSyncedAt: assertIso(row.updated_at, "mail_folder.updated_at"),
        createdAt: assertIso(row.created_at, "mail_folder.created_at"),
        updatedAt: assertIso(row.updated_at, "mail_folder.updated_at"),
      }))
    : [];

  const syncCheckpoints: MappedLegacySyncCheckpoint[] = existingTables.has("mailbox_sources")
    ? (sourceDb.prepare(`
        SELECT account_id, status, last_sync_at, last_success_at, last_error_code, last_error_message, updated_at
        FROM mailbox_sources
        WHERE account_id IS NOT NULL AND source_kind = 'imap'
        ORDER BY updated_at DESC, id ASC
      `).all() as Array<{
        account_id: string; status: string; last_sync_at: string | null;
        last_success_at: string | null; last_error_code: string | null;
        last_error_message: string | null; updated_at: string;
      }>)
      .filter((row) => importedAccountIds.has(row.account_id))
      .reduce<MappedLegacySyncCheckpoint[]>((acc, row) => {
        if (acc.some((item) => item.accountId === row.account_id)) return acc;
        const syncState: MailAccountSyncState = row.status === "auth_failed"
          ? "auth_failed"
          : row.last_error_code
            ? "error"
            : row.last_success_at
              ? "stale"
              : "never_synced";
        acc.push({
          accountId: row.account_id,
          syncState,
          lastAttemptAt: row.last_sync_at ? assertIso(row.last_sync_at, "mailbox_source.last_sync_at") : null,
          lastSyncedAt: row.last_success_at ? assertIso(row.last_success_at, "mailbox_source.last_success_at") : null,
          lastErrorCode: row.last_error_code ?? null,
          lastErrorMessage: row.last_error_message ?? null,
          updatedAt: assertIso(row.updated_at, "mailbox_source.updated_at"),
        });
        return acc;
      }, [])
    : [];

  let easyEmailServiceUrl: string | null = null;
  let avatarSettings: MappedLegacyAvatarSettings | null = null;
  if (existingTables.has("app_settings")) {
    const settingRows = sourceDb.prepare(
      "SELECT key, value_json, updated_at FROM app_settings",
    ).all() as Array<{ key: string; value_json: string; updated_at: string }>;
    for (const row of settingRows) {
      if (row.key === "easyemail.connection") {
        easyEmailServiceUrl = sanitizeEasyEmailServiceUrl(row.value_json);
      } else if (row.key === "sender_avatar.settings") {
        try {
          const parsed = JSON.parse(row.value_json) as Record<string, unknown>;
          avatarSettings = {
            remoteEnabled: typeof parsed.remote_enabled === "boolean" ? parsed.remote_enabled : true,
            bimiEnabled: typeof parsed.bimi_enabled === "boolean" ? parsed.bimi_enabled : true,
            faviconEnabled: typeof parsed.favicon_enabled === "boolean" ? parsed.favicon_enabled : true,
            authEnabled: typeof parsed.auth_enabled === "boolean" ? parsed.auth_enabled : true,
            updatedAt: assertIso(row.updated_at, "app_settings.updated_at"),
          };
        } catch {
          avatarSettings = null;
        }
      }
    }
  }

  const avatarCacheEntries: MappedLegacyAvatarCacheEntry[] = [];
  if (existingTables.has("sender_avatar_cache")) {
    const rows = sourceDb.prepare(`
      SELECT cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
             remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
             created_at, updated_at
      FROM sender_avatar_cache ORDER BY updated_at ASC, cache_key ASC
    `).all() as Array<{
      cache_key: string; sender_domain: string; normalized_sender: string | null; source_kind: string;
      image_mime: string | null; image_bytes: Uint8Array | null; remote_url: string | null;
      fallback_text: string; status: string; auth_json: string; last_error: string | null;
      fetched_at: string; expires_at: string; created_at: string; updated_at: string;
    }>;
    for (const row of rows) {
      let status: "ok" | "failed" = row.status === "ok" || row.status === "ready" || row.status === "hit"
        ? "ok"
        : "failed";
      let imageMime = row.image_mime?.trim().toLowerCase() ?? null;
      let imageBytes = row.image_bytes ? new Uint8Array(row.image_bytes) : null;
      if (imageBytes && imageMime) {
        if (!ALLOWED_AVATAR_MIMES.has(imageMime) || imageBytes.byteLength > MAX_CACHED_AVATAR_BYTES) {
          imageMime = null;
          imageBytes = null;
          status = "failed";
        } else if (imageMime === "image/svg+xml") {
          try {
            validateSafeSvgBytes(Buffer.from(imageBytes));
          } catch {
            imageMime = null;
            imageBytes = null;
            status = "failed";
          }
        }
      }
      avatarCacheEntries.push({
        cacheKey: row.cache_key.trim(),
        senderDomain: row.sender_domain.trim().toLowerCase(),
        normalizedSender: (row.normalized_sender ?? row.sender_domain).trim().toLowerCase(),
        sourceKind: row.source_kind.trim() || "fallback",
        imageMime,
        imageBytes,
        remoteUrl: row.remote_url?.startsWith("https://") ? row.remote_url.trim() : null,
        fallbackText: row.fallback_text.trim() || "?",
        status,
        authJson: row.auth_json || "{}",
        lastError: row.last_error ?? null,
        fetchedAt: assertIso(row.fetched_at, "sender_avatar_cache.fetched_at"),
        expiresAt: assertIso(row.expires_at, "sender_avatar_cache.expires_at"),
        createdAt: assertIso(row.created_at, "sender_avatar_cache.created_at"),
        updatedAt: assertIso(row.updated_at, "sender_avatar_cache.updated_at"),
      });
    }
  }

  const contactAvatarOverrides: MappedLegacyContactAvatarOverride[] = [];
  if (existingTables.has("contact_avatar_overrides")) {
    const rows = sourceDb.prepare(`
      SELECT sender_key, normalized_sender, sender_domain, image_mime, image_bytes,
             display_name, created_at, updated_at
      FROM contact_avatar_overrides ORDER BY updated_at ASC, sender_key ASC
    `).all() as Array<{
      sender_key: string; normalized_sender: string; sender_domain: string;
      image_mime: string; image_bytes: Uint8Array; display_name: string | null;
      created_at: string; updated_at: string;
    }>;
    for (const row of rows) {
      const mime = row.image_mime.trim().toLowerCase();
      const bytes = new Uint8Array(row.image_bytes);
      if (!ALLOWED_AVATAR_MIMES.has(mime) || bytes.byteLength === 0 || bytes.byteLength > MAX_CONTACT_OVERRIDE_BYTES) {
        continue;
      }
      if (mime === "image/svg+xml") {
        try {
          validateSafeSvgBytes(Buffer.from(bytes));
        } catch {
          continue;
        }
      }
      contactAvatarOverrides.push({
        senderKey: row.sender_key.trim().toLowerCase(),
        normalizedSender: row.normalized_sender.trim().toLowerCase(),
        senderDomain: row.sender_domain.trim().toLowerCase(),
        imageMime: mime,
        imageBytes: bytes,
        displayName: (row.display_name ?? row.normalized_sender).trim(),
        createdAt: assertIso(row.created_at, "contact_avatar_override.created_at"),
        updatedAt: assertIso(row.updated_at, "contact_avatar_override.updated_at"),
      });
    }
  }

  return {
    tempSessions,
    contacts,
    taxonomyItems,
    imapFolders,
    syncCheckpoints,
    easyEmailServiceUrl,
    avatarSettings,
    avatarCacheEntries,
    contactAvatarOverrides,
  };
}
