import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import type { MappedLegacyAccount } from "./legacy-account-mapper.js";
import type { MappedLegacyCatalogDomains } from "./legacy-domain-mappers.js";
import type {
  LegacyMessageSampleHash,
  MappedLegacyMailActivityDomains,
} from "./legacy-mail-activity-mappers.js";
import { writeLegacyActivityAndVerifyTarget } from "./legacy-target-activity-writer.js";

export interface LegacyTargetDomainCounts {
  accounts: number;
  credentialRefs: number;
  contacts: number;
  taxonomyItems: number;
  imapFolders: number;
  syncCheckpoints: number;
  messages: number;
  messageSources: number;
  verificationCodes: number;
  newsletterOverrides: number;
  sendQueueItems: number;
  agentServices: number;
  agentThreads: number;
  agentMessages: number;
  clientSettings: number;
  avatarSettings: number;
  avatarCacheEntries: number;
  contactAvatarOverrides: number;
  tempSessions: number;
}

export interface LegacyWriteExecutionResult {
  importedCounts: LegacyTargetDomainCounts;
  skippedExistingCounts: LegacyTargetDomainCounts;
  reauthRequiredCount: number;
  queueStatusSummary: Record<string, number>;
  verifiedMessageSamples: LegacyMessageSampleHash[];
}

function emptyDomainCounts(): LegacyTargetDomainCounts {
  return {
    accounts: 0,
    credentialRefs: 0,
    contacts: 0,
    taxonomyItems: 0,
    imapFolders: 0,
    syncCheckpoints: 0,
    messages: 0,
    messageSources: 0,
    verificationCodes: 0,
    newsletterOverrides: 0,
    sendQueueItems: 0,
    agentServices: 0,
    agentThreads: 0,
    agentMessages: 0,
    clientSettings: 0,
    avatarSettings: 0,
    avatarCacheEntries: 0,
    contactAvatarOverrides: 0,
    tempSessions: 0,
  };
}

export function writeLegacyDomainsIntoTargetTransaction(options: {
  targetDb: DatabaseSync;
  accounts: MappedLegacyAccount[];
  catalog: MappedLegacyCatalogDomains;
  activity: MappedLegacyMailActivityDomains;
  receiptId: string;
  importerVersion: number;
  sourceSha256: string;
  sourceSchemaVersion: number;
  sourceAccountCount: number;
  sourceCredentialRefCount: number;
  sourceTableRowCounts: Record<string, number>;
  importedTempSessionCount: number;
  skippedTempSessionCount: number;
  importedAt: string;
  beforeCommitHook?: () => void;
}): LegacyWriteExecutionResult {
  const { targetDb, accounts, catalog, activity } = options;
  const imported = emptyDomainCounts();
  const skipped = emptyDomainCounts();
  imported.tempSessions = options.importedTempSessionCount;
  skipped.tempSessions = options.skippedTempSessionCount;
  let reauthRequiredCount = 0;

  const findAcctStmt = targetDb.prepare(
    "SELECT id, kind, primary_address FROM mail_accounts WHERE id = ?",
  );
  const findLiveAddrStmt = targetDb.prepare(
    "SELECT id FROM mail_accounts WHERE lower(primary_address) = lower(?) AND deleted_at IS NULL",
  );
  const findCredConflictStmt = targetDb.prepare(
    "SELECT id, owner_account_id FROM mail_account_credential_refs WHERE secret_backend = ? AND secret_key = ?",
  );
  const insertAcctStmt = targetDb.prepare(`
    INSERT INTO mail_accounts (
      id, scope, kind, display_name, primary_address, provider_label,
      imap_host, imap_port, imap_security, imap_username,
      smtp_host, smtp_port, smtp_security, smtp_username,
      status, auth_status, receive_status, send_status,
      listed_in_all_accounts, version, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  const insertCredStmt = targetDb.prepare(`
    INSERT INTO mail_account_credential_refs (
      id, owner_account_id, secret_backend, secret_key, credential_kind,
      auth_method, status, created_at, updated_at, last_verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  targetDb.exec("BEGIN IMMEDIATE");
  try {
    for (const account of accounts) {
      const existing = findAcctStmt.get(account.id) as {
        id: string; kind: string; primary_address: string | null;
      } | undefined;
      if (existing) {
        if (
          existing.kind !== account.kind
          || (existing.primary_address ?? "").toLowerCase() !== account.primaryAddress.toLowerCase()
        ) {
          throw new EasyEmailError(
            "LEGACY_IMPORT_CONFLICT",
            `Existing canonical account ${account.id} conflicts with legacy account metadata.`,
          );
        }
        skipped.accounts += 1;
        skipped.credentialRefs += account.credentialRefs.length;
        continue;
      }
      if (account.deletedAt === null) {
        const liveConflict = findLiveAddrStmt.get(account.primaryAddress) as { id: string } | undefined;
        if (liveConflict) {
          throw new EasyEmailError(
            "LEGACY_IMPORT_ADDRESS_CONFLICT",
            `Canonical account ${liveConflict.id} already owns address ${account.primaryAddress}.`,
          );
        }
      }
      insertAcctStmt.run(
        account.id, account.scope, account.kind, account.displayName, account.primaryAddress,
        account.providerLabel, account.imap?.host ?? null, account.imap?.port ?? null,
        account.imap?.security ?? null, account.imap?.username ?? null,
        account.smtp?.host ?? null, account.smtp?.port ?? null,
        account.smtp?.security ?? null, account.smtp?.username ?? null,
        account.status, account.authStatus, account.receiveStatus, account.sendStatus,
        account.listedInAllAccounts ? 1 : 0, account.createdAt, account.updatedAt, account.deletedAt,
      );
      imported.accounts += 1;
      if (account.reauthMarked) reauthRequiredCount += 1;

      for (const ref of account.credentialRefs) {
        const conflict = findCredConflictStmt.get(ref.secretBackend, ref.secretKey) as {
          id: string; owner_account_id: string;
        } | undefined;
        if (conflict && conflict.owner_account_id !== account.id) {
          throw new EasyEmailError(
            "LEGACY_IMPORT_CREDENTIAL_CONFLICT",
            `Credential reference ${ref.secretKey} is already owned by another account.`,
          );
        }
        insertCredStmt.run(
          ref.id, ref.ownerAccountId, ref.secretBackend, ref.secretKey,
          ref.credentialKind, ref.authMethod, ref.status, ref.createdAt, ref.updatedAt, ref.lastVerifiedAt,
        );
        imported.credentialRefs += 1;
      }
    }

    const contactIdByEmail = new Map<string, string>();
    const findContactById = targetDb.prepare("SELECT id, email_address FROM contacts WHERE id = ?");
    const findContactByEmail = targetDb.prepare("SELECT id FROM contacts WHERE lower(email_address) = lower(?)");
    const insertContact = targetDb.prepare(`
      INSERT INTO contacts (id, display_name, email_address, note, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?)
    `);
    for (const contact of catalog.contacts) {
      const byId = findContactById.get(contact.id) as { id: string; email_address: string } | undefined;
      if (byId) {
        contactIdByEmail.set(byId.email_address.toLowerCase(), byId.id);
        skipped.contacts += 1;
        continue;
      }
      const byEmail = findContactByEmail.get(contact.emailAddress) as { id: string } | undefined;
      if (byEmail) {
        contactIdByEmail.set(contact.emailAddress, byEmail.id);
        skipped.contacts += 1;
        continue;
      }
      insertContact.run(
        contact.id, contact.displayName, contact.emailAddress,
        contact.note, contact.createdAt, contact.updatedAt,
      );
      contactIdByEmail.set(contact.emailAddress, contact.id);
      imported.contacts += 1;
    }

    const findTaxById = targetDb.prepare("SELECT id FROM mail_taxonomy_items WHERE id = ?");
    const findTaxByName = targetDb.prepare(
      "SELECT id FROM mail_taxonomy_items WHERE kind = ? AND normalized_name = ?",
    );
    const insertTax = targetDb.prepare(`
      INSERT INTO mail_taxonomy_items (
        id, kind, name, normalized_name, parent_id, color, sort_order, system, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `);
    const taxIdMap = new Map<string, string>();
    for (const item of catalog.taxonomyItems) {
      const existingById = findTaxById.get(item.id) as { id: string } | undefined;
      if (existingById) {
        taxIdMap.set(item.id, existingById.id);
        skipped.taxonomyItems += 1;
        continue;
      }
      const existingByName = findTaxByName.get(item.kind, item.normalizedName) as { id: string } | undefined;
      if (existingByName) {
        taxIdMap.set(item.id, existingByName.id);
        skipped.taxonomyItems += 1;
        continue;
      }
      const resolvedParent = item.parentId ? (taxIdMap.get(item.parentId) ?? null) : null;
      insertTax.run(
        item.id, item.kind, item.name, item.normalizedName, resolvedParent,
        item.color, item.sortOrder, item.system ? 1 : 0, item.createdAt, item.updatedAt,
      );
      taxIdMap.set(item.id, item.id);
      imported.taxonomyItems += 1;
    }

    const folderIdMap = new Map<string, string>();
    const findFolderById = targetDb.prepare("SELECT id FROM mail_imap_folders WHERE id = ?");
    const findFolderByProvider = targetDb.prepare(
      "SELECT id FROM mail_imap_folders WHERE account_id = ? AND provider_folder_id = ?",
    );
    const insertFolder = targetDb.prepare(`
      INSERT INTO mail_imap_folders (
        id, account_id, source_ref_id, provider_folder_id, display_name, path, delimiter,
        folder_kind, special_use, uid_validity, last_seen_uid, last_synced_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
    `);
    for (const folder of catalog.imapFolders) {
      const existingProvider = findFolderByProvider.get(folder.accountId, folder.providerFolderId) as { id: string } | undefined;
      if (existingProvider) {
        folderIdMap.set(folder.id, existingProvider.id);
        skipped.imapFolders += 1;
        continue;
      }
      const existingId = findFolderById.get(folder.id) as { id: string } | undefined;
      if (existingId) {
        folderIdMap.set(folder.id, existingId.id);
        skipped.imapFolders += 1;
        continue;
      }
      insertFolder.run(
        folder.id, folder.accountId, folder.sourceRefId, folder.providerFolderId,
        folder.displayName, folder.path, folder.delimiter, folder.folderKind,
        folder.lastSeenUid, folder.lastSyncedAt, folder.createdAt, folder.updatedAt,
      );
      folderIdMap.set(folder.id, folder.id);
      imported.imapFolders += 1;
    }

    const findCheckpoint = targetDb.prepare(
      "SELECT account_id FROM mail_account_sync_checkpoints WHERE account_id = ?",
    );
    const insertCheckpoint = targetDb.prepare(`
      INSERT INTO mail_account_sync_checkpoints (
        account_id, sync_state, last_attempt_at, last_synced_at,
        last_fetched_count, last_inserted_count, last_error_code, last_error_message, updated_at
      ) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)
    `);
    for (const cp of catalog.syncCheckpoints) {
      if (findCheckpoint.get(cp.accountId)) {
        skipped.syncCheckpoints += 1;
        continue;
      }
      insertCheckpoint.run(
        cp.accountId, cp.syncState, cp.lastAttemptAt, cp.lastSyncedAt,
        cp.lastErrorCode, cp.lastErrorMessage, cp.updatedAt,
      );
      imported.syncCheckpoints += 1;
    }

    if (catalog.easyEmailServiceUrl) {
      const existingSetting = targetDb.prepare(
        "SELECT setting_value FROM mail_client_settings WHERE setting_key = 'easyemail.service_url'",
      ).get() as { setting_value: string | null } | undefined;
      if (existingSetting) {
        skipped.clientSettings += 1;
      } else {
        targetDb.prepare(`
          INSERT INTO mail_client_settings (setting_key, setting_value, updated_at)
          VALUES ('easyemail.service_url', ?, ?)
        `).run(catalog.easyEmailServiceUrl, options.importedAt);
        imported.clientSettings += 1;
      }
    }

    if (catalog.avatarSettings) {
      const existingAvatarCfg = targetDb.prepare(
        "SELECT singleton_id FROM mail_avatar_settings WHERE singleton_id = 1",
      ).get();
      if (existingAvatarCfg) {
        skipped.avatarSettings += 1;
      } else {
        targetDb.prepare(`
          INSERT INTO mail_avatar_settings (
            singleton_id, remote_enabled, bimi_enabled, favicon_enabled, auth_enabled, updated_at
          ) VALUES (1, ?, ?, ?, ?, ?)
        `).run(
          catalog.avatarSettings.remoteEnabled ? 1 : 0,
          catalog.avatarSettings.bimiEnabled ? 1 : 0,
          catalog.avatarSettings.faviconEnabled ? 1 : 0,
          catalog.avatarSettings.authEnabled ? 1 : 0,
          catalog.avatarSettings.updatedAt,
        );
        imported.avatarSettings += 1;
      }
    }

    const findAvatarCache = targetDb.prepare(
      "SELECT cache_key FROM mail_sender_avatar_cache WHERE cache_key = ?",
    );
    const insertAvatarCache = targetDb.prepare(`
      INSERT INTO mail_sender_avatar_cache (
        cache_key, sender_domain, normalized_sender, source_kind, image_mime, image_bytes,
        remote_url, fallback_text, status, auth_json, last_error, fetched_at, expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of catalog.avatarCacheEntries) {
      if (findAvatarCache.get(entry.cacheKey)) {
        skipped.avatarCacheEntries += 1;
        continue;
      }
      insertAvatarCache.run(
        entry.cacheKey, entry.senderDomain, entry.normalizedSender, entry.sourceKind,
        entry.imageMime, entry.imageBytes, entry.remoteUrl, entry.fallbackText,
        entry.status, entry.authJson, entry.lastError, entry.fetchedAt, entry.expiresAt,
        entry.createdAt, entry.updatedAt,
      );
      imported.avatarCacheEntries += 1;
    }

    const findAvatarOverride = targetDb.prepare(
      "SELECT sender_key FROM mail_contact_avatar_overrides WHERE sender_key = ?",
    );
    const insertAvatarOverride = targetDb.prepare(`
      INSERT INTO mail_contact_avatar_overrides (
        sender_key, contact_id, normalized_sender, sender_domain,
        image_mime, image_bytes, display_name, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const ov of catalog.contactAvatarOverrides) {
      if (findAvatarOverride.get(ov.senderKey)) {
        skipped.contactAvatarOverrides += 1;
        continue;
      }
      const contactId = contactIdByEmail.get(ov.normalizedSender) ?? null;
      insertAvatarOverride.run(
        ov.senderKey, contactId, ov.normalizedSender, ov.senderDomain,
        ov.imageMime, ov.imageBytes, ov.displayName, ov.createdAt, ov.updatedAt,
      );
      imported.contactAvatarOverrides += 1;
    }

    const { queueStatusSummary, verifiedMessageSamples } = writeLegacyActivityAndVerifyTarget({
      targetDb,
      activity,
      folderIdMap,
      imported,
      skipped,
      insertCredStmt,
    });

    const detailsJson = JSON.stringify({
      sourceTableRowCounts: options.sourceTableRowCounts,
      importedCounts: imported,
      skippedExistingCounts: skipped,
      queueStatusSummary,
      verifiedMessageSamples,
    });
    targetDb.prepare(`
      INSERT INTO legacy_import_receipts (
        id, importer_version, domain, source_sha256, source_schema_version,
        source_account_count, source_credential_ref_count,
        imported_account_count, skipped_existing_count, reauth_required_count,
        imported_at, details_json
      ) VALUES (?, ?, 'full_database', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      options.receiptId,
      options.importerVersion,
      options.sourceSha256,
      options.sourceSchemaVersion,
      options.sourceAccountCount,
      options.sourceCredentialRefCount,
      imported.accounts,
      skipped.accounts,
      reauthRequiredCount,
      options.importedAt,
      detailsJson,
    );

    options.beforeCommitHook?.();
    targetDb.exec("COMMIT");

    return {
      importedCounts: imported,
      skippedExistingCounts: skipped,
      reauthRequiredCount,
      queueStatusSummary,
      verifiedMessageSamples,
    };
  } catch (error) {
    targetDb.exec("ROLLBACK");
    throw error;
  }
}
