import type { DatabaseSync } from "node:sqlite";

import { EasyEmailError } from "../../domain/errors.js";
import {
  computeCanonicalMessageSampleHash,
  type LegacyMessageSampleHash,
  type MappedLegacyMailActivityDomains,
} from "./legacy-mail-activity-mappers.js";
import type { LegacyTargetDomainCounts } from "./legacy-target-writer.js";

export function writeLegacyActivityAndVerifyTarget(options: {
  targetDb: DatabaseSync;
  activity: MappedLegacyMailActivityDomains;
  folderIdMap: ReadonlyMap<string, string>;
  imported: LegacyTargetDomainCounts;
  skipped: LegacyTargetDomainCounts;
  insertCredStmt: ReturnType<DatabaseSync["prepare"]>;
}): {
  queueStatusSummary: Record<string, number>;
  verifiedMessageSamples: LegacyMessageSampleHash[];
} {
  const { targetDb, activity, folderIdMap, imported, skipped, insertCredStmt } = options;

  const findMsg = targetDb.prepare("SELECT id FROM mail_messages WHERE id = ?");
  const insertMsg = targetDb.prepare(`
    INSERT INTO mail_messages (
      id, rfc_message_id, thread_key, subject, from_address, from_name, snippet,
      body_text, body_html, body_cache_state, has_attachments, classification,
      newsletter_list_id, newsletter_unsubscribe_json,
      observed_at, version, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `);
  for (const msg of activity.messages) {
    if (findMsg.get(msg.id)) {
      skipped.messages += 1;
      continue;
    }
    insertMsg.run(
      msg.id, msg.rfcMessageId, msg.threadKey, msg.subject, msg.fromAddress, msg.fromName,
      msg.snippet, msg.bodyText, msg.bodyHtml, msg.bodyCacheState, msg.hasAttachments ? 1 : 0,
      msg.classification, msg.newsletterListId, msg.newsletterUnsubscribeJson,
      msg.observedAt, msg.createdAt, msg.updatedAt, msg.deletedAt,
    );
    imported.messages += 1;
  }

  const findSrcById = targetDb.prepare("SELECT id FROM mail_message_sources WHERE id = ?");
  const findSrcDedupe = targetDb.prepare(`
    SELECT id FROM mail_message_sources
    WHERE source_kind = ? AND source_ref_id = ? AND external_message_id = ?
  `);
  const insertSrc = targetDb.prepare(`
    INSERT INTO mail_message_sources (
      id, message_id, source_kind, source_ref_id, account_id, session_id,
      provider_instance_id, external_message_id, received_address, provider_label,
      lifecycle_state, is_read, is_starred, is_archived, is_important,
      local_folder, labels_json, draft_cc_json, draft_bcc_json,
      imap_folder_id, imap_uid, imap_uid_validity, first_seen_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const src of activity.messageSources) {
    if (
      findSrcById.get(src.id)
      || (src.externalMessageId && findSrcDedupe.get(src.sourceKind, src.sourceRefId, src.externalMessageId))
    ) {
      skipped.messageSources += 1;
      continue;
    }
    const mappedFolderId = src.legacyFolderId ? (folderIdMap.get(src.legacyFolderId) ?? null) : null;
    insertSrc.run(
      src.id, src.messageId, src.sourceKind, src.sourceRefId, src.accountId, src.sessionId,
      src.providerInstanceId, src.externalMessageId, src.receivedAddress, src.providerLabel,
      src.lifecycleState, src.isRead ? 1 : 0, src.isStarred ? 1 : 0, src.isArchived ? 1 : 0,
      src.isImportant ? 1 : 0, src.localFolder, src.labelsJson, src.draftCcJson, src.draftBccJson,
      mappedFolderId, src.imapUid, src.imapUidValidity, src.firstSeenAt, src.lastSeenAt,
    );
    imported.messageSources += 1;
  }

  const findVerif = targetDb.prepare(
    "SELECT id FROM mail_verification_codes WHERE id = ? OR (message_id = ? AND code = ?)",
  );
  const insertVerif = targetDb.prepare(`
    INSERT INTO mail_verification_codes (
      id, message_id, session_id, source_ref_id, account_scope, received_address,
      code, code_source, candidates_json, issuer_hint, target_service_hint,
      confidence, expires_at, extracted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const code of activity.verificationCodes) {
    if (findVerif.get(code.id, code.messageId, code.code)) {
      skipped.verificationCodes += 1;
      continue;
    }
    insertVerif.run(
      code.id, code.messageId, code.sessionId, code.sourceRefId, code.accountScope,
      code.receivedAddress, code.code, code.codeSource, code.candidatesJson,
      code.issuerHint, code.targetServiceHint, code.confidence, code.expiresAt, code.extractedAt,
    );
    imported.verificationCodes += 1;
  }

  const findNewsOverride = targetDb.prepare(`
    SELECT 1 FROM mail_newsletter_subscription_overrides
    WHERE account_id = ? AND subscription_key = ?
  `);
  const insertNewsOverride = targetDb.prepare(`
    INSERT INTO mail_newsletter_subscription_overrides (account_id, subscription_key, hidden, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const ov of activity.newsletterOverrides) {
    if (findNewsOverride.get(ov.accountId, ov.subscriptionKey)) {
      skipped.newsletterOverrides += 1;
      continue;
    }
    insertNewsOverride.run(ov.accountId, ov.subscriptionKey, ov.hidden ? 1 : 0, ov.updatedAt);
    imported.newsletterOverrides += 1;
  }

  const findQueue = targetDb.prepare("SELECT id FROM mail_send_queue WHERE id = ?");
  const findAccountCred = targetDb.prepare(
    "SELECT id FROM mail_account_credential_refs WHERE owner_account_id = ? ORDER BY created_at ASC LIMIT 1",
  );
  const insertQueue = targetDb.prepare(`
    INSERT INTO mail_send_queue (
      id, account_id, account_scope, source_id, message_id, sender_address,
      smtp_host, smtp_port, smtp_security, smtp_username, credential_ref_id,
      target_address, cc_addresses_json, bcc_addresses_json, idempotency_key,
      payload_fingerprint, status, attempt_count, scheduled_at, next_retry_at,
      lease_owner, lease_expires_at, provider_message_id,
      last_error_code, last_error_message, version, created_at, updated_at, sent_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 1, ?, ?, ?)
  `);
  const queueStatusSummary: Record<string, number> = {};
  for (const item of activity.sendQueueItems) {
    queueStatusSummary[item.status] = (queueStatusSummary[item.status] ?? 0) + 1;
    if (findQueue.get(item.id)) {
      skipped.sendQueueItems += 1;
      continue;
    }
    let credId = item.preferredCredentialRefId;
    if (!credId) {
      const existingCred = findAccountCred.get(item.accountId) as { id: string } | undefined;
      if (existingCred) {
        credId = existingCred.id;
      } else {
        credId = `cred_legacy_smtp_${item.accountId}`;
        insertCredStmt.run(
          credId, item.accountId, "legacy_import_placeholder", `secret://smtp/${item.accountId}`,
          "smtp_password", "password", "missing", item.createdAt, item.updatedAt, null,
        );
        imported.credentialRefs += 1;
      }
    }
    insertQueue.run(
      item.id, item.accountId, item.accountScope, item.sourceId, item.messageId,
      item.senderAddress, item.smtpHost, item.smtpPort, item.smtpSecurity,
      item.smtpUsername, credId, item.targetAddress, item.ccAddressesJson,
      item.bccAddressesJson, item.payloadFingerprint, item.status, item.attemptCount,
      item.scheduledAt, item.nextRetryAt, item.lastErrorCode, item.lastErrorMessage,
      item.createdAt, item.updatedAt, item.sentAt,
    );
    imported.sendQueueItems += 1;
  }

  const findAgentSvc = targetDb.prepare("SELECT id FROM mail_agent_services WHERE id = ?");
  const findAgentSvcByEmail = targetDb.prepare(
    "SELECT id FROM mail_agent_services WHERE lower(email_address) = lower(?) AND deleted_at IS NULL",
  );
  const insertAgentSvc = targetDb.prepare(`
    INSERT INTO mail_agent_services (
      id, display_name, email_address, description, service_kind, trust_level,
      default_sender_account_id, status, created_at, updated_at, deleted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const agentSvcIdMap = new Map<string, string>();
  for (const svc of activity.agentServices) {
    const byId = findAgentSvc.get(svc.id) as { id: string } | undefined;
    if (byId) {
      agentSvcIdMap.set(svc.id, byId.id);
      skipped.agentServices += 1;
      continue;
    }
    if (svc.deletedAt === null) {
      const byEmail = findAgentSvcByEmail.get(svc.emailAddress) as { id: string } | undefined;
      if (byEmail) {
        agentSvcIdMap.set(svc.id, byEmail.id);
        skipped.agentServices += 1;
        continue;
      }
    }
    insertAgentSvc.run(
      svc.id, svc.displayName, svc.emailAddress, svc.description, svc.serviceKind,
      svc.trustLevel, svc.defaultSenderAccountId, svc.status,
      svc.createdAt, svc.updatedAt, svc.deletedAt,
    );
    agentSvcIdMap.set(svc.id, svc.id);
    imported.agentServices += 1;
  }

  const findAgentThread = targetDb.prepare("SELECT id FROM mail_agent_threads WHERE id = ?");
  const insertAgentThread = targetDb.prepare(`
    INSERT INTO mail_agent_threads (
      id, agent_service_id, sender_account_id, subject, status,
      last_outgoing_message_id, last_incoming_message_id, correlation_key,
      idempotency_key, payload_fingerprint, created_at, updated_at, completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)
  `);
  for (const thr of activity.agentThreads) {
    if (findAgentThread.get(thr.id)) {
      skipped.agentThreads += 1;
      continue;
    }
    const mappedSvcId = agentSvcIdMap.get(thr.agentServiceId) ?? thr.agentServiceId;
    insertAgentThread.run(
      thr.id, mappedSvcId, thr.senderAccountId, thr.subject, thr.status,
      thr.lastOutgoingMessageId, thr.lastIncomingMessageId, thr.correlationKey,
      thr.createdAt, thr.updatedAt, thr.completedAt,
    );
    imported.agentThreads += 1;
  }

  const findAgentMsg = targetDb.prepare(
    "SELECT id FROM mail_agent_messages WHERE id = ? OR (thread_id = ? AND message_id = ? AND direction = ?)",
  );
  const insertAgentMsg = targetDb.prepare(`
    INSERT INTO mail_agent_messages (
      id, thread_id, message_id, direction, semantic_role,
      parsed_status, parsed_payload_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const am of activity.agentMessages) {
    if (findAgentMsg.get(am.id, am.threadId, am.messageId, am.direction)) {
      skipped.agentMessages += 1;
      continue;
    }
    insertAgentMsg.run(
      am.id, am.threadId, am.messageId, am.direction, am.semanticRole,
      am.parsedStatus, am.parsedPayloadJson, am.createdAt,
    );
    imported.agentMessages += 1;
  }

  const fkViolations = targetDb.prepare("PRAGMA foreign_key_check").all();
  if (fkViolations.length > 0) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_VERIFICATION_FAILED",
      "Target relational database failed foreign_key_check.",
    );
  }

  const orphanMsg = targetDb.prepare(`
    SELECT m.id FROM mail_messages m
    LEFT JOIN mail_message_sources s ON s.message_id = m.id
    WHERE s.id IS NULL
    LIMIT 1
  `).get() as { id: string } | undefined;
  if (orphanMsg) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_VERIFICATION_FAILED",
      `Imported message ${orphanMsg.id} is missing source linkage.`,
    );
  }

  const stuckSending = targetDb.prepare(
    "SELECT COUNT(*) AS count FROM mail_send_queue WHERE status = 'sending'",
  ).get() as { count: number };
  if (stuckSending.count > 0) {
    throw new EasyEmailError(
      "LEGACY_IMPORT_VERIFICATION_FAILED",
      "Target send queue contains unrecovered transient 'sending' rows after import.",
    );
  }

  const readMsgSampleStmt = targetDb.prepare(`
    SELECT id, rfc_message_id, subject, from_address, body_text, body_html
    FROM mail_messages WHERE id = ?
  `);
  const verifiedMessageSamples: LegacyMessageSampleHash[] = [];
  for (const expectedSample of activity.messageSampleHashes) {
    const targetRow = readMsgSampleStmt.get(expectedSample.messageId) as {
      id: string; rfc_message_id: string | null; subject: string;
      from_address: string; body_text: string | null; body_html: string | null;
    } | undefined;
    if (!targetRow) {
      throw new EasyEmailError(
        "LEGACY_IMPORT_VERIFICATION_FAILED",
        `Sampled message ${expectedSample.messageId} missing from target database.`,
      );
    }
    const actualHash = computeCanonicalMessageSampleHash({
      id: targetRow.id,
      rfcMessageId: targetRow.rfc_message_id,
      subject: targetRow.subject,
      fromAddress: targetRow.from_address,
      bodyText: targetRow.body_text,
      bodyHtml: targetRow.body_html,
    });
    if (actualHash !== expectedSample.sha256) {
      throw new EasyEmailError(
        "LEGACY_IMPORT_VERIFICATION_FAILED",
        `Sampled message ${expectedSample.messageId} hash mismatch after import.`,
      );
    }
    verifiedMessageSamples.push({ messageId: expectedSample.messageId, sha256: actualHash });
  }

  return { queueStatusSummary, verifiedMessageSamples };
}
