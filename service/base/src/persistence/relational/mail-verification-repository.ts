import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  MailVerificationListQuery,
  MailVerificationRecord,
  MailVerificationRepository,
  MailVerificationUpsertInput,
} from "../../domain/mail-message.js";
import {
  mapMailVerificationRow,
  type RawMailVerificationRow,
} from "./mail-message-row-mapper.js";

const VERIFICATION_SELECT_COLUMNS = `
  v.id,
  v.message_id,
  v.session_id,
  v.source_ref_id,
  v.account_scope,
  v.received_address,
  v.code,
  v.code_source,
  v.candidates_json,
  v.issuer_hint,
  v.target_service_hint,
  v.confidence,
  v.expires_at,
  v.extracted_at,
  m.subject,
  m.from_address,
  m.observed_at
`;

export class SqliteMailVerificationRepository implements MailVerificationRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public async upsertMailVerificationCode(
    input: MailVerificationUpsertInput,
    nowMs: number,
  ): Promise<MailVerificationRecord> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare(
        "SELECT id FROM mail_verification_codes WHERE message_id = ? AND code = ? LIMIT 1",
      ).get(input.messageId, input.code) as unknown as { id: string } | undefined;

      const resolvedId = existing?.id ?? input.id;
      const candidatesJson = JSON.stringify(input.candidates);

      if (existing) {
        this.database.prepare(`
          UPDATE mail_verification_codes
          SET session_id = ?,
              source_ref_id = ?,
              account_scope = ?,
              received_address = ?,
              code_source = ?,
              candidates_json = ?,
              issuer_hint = ?,
              target_service_hint = ?,
              confidence = ?,
              expires_at = ?,
              extracted_at = ?
          WHERE id = ?
        `).run(
          input.sessionId ?? null,
          input.sourceRefId,
          input.accountScope,
          input.receivedAddress,
          input.codeSource,
          candidatesJson,
          input.issuerHint ?? null,
          input.targetServiceHint ?? null,
          input.confidence,
          input.expiresAt ?? null,
          input.extractedAt,
          resolvedId,
        );
      } else {
        this.database.prepare(`
          INSERT INTO mail_verification_codes (
            id, message_id, session_id, source_ref_id, account_scope,
            received_address, code, code_source, candidates_json,
            issuer_hint, target_service_hint, confidence, expires_at, extracted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          resolvedId,
          input.messageId,
          input.sessionId ?? null,
          input.sourceRefId,
          input.accountScope,
          input.receivedAddress,
          input.code,
          input.codeSource,
          candidatesJson,
          input.issuerHint ?? null,
          input.targetServiceHint ?? null,
          input.confidence,
          input.expiresAt ?? null,
          input.extractedAt,
        );
      }

      this.database.prepare(
        "DELETE FROM mail_verification_codes WHERE message_id = ? AND id != ?",
      ).run(input.messageId, resolvedId);

      const row = this.database.prepare(`
        SELECT ${VERIFICATION_SELECT_COLUMNS}
        FROM mail_verification_codes v
        INNER JOIN mail_messages m ON m.id = v.message_id
        WHERE v.id = ?
      `).get(resolvedId) as unknown as RawMailVerificationRow | undefined;

      if (!row) {
        throw new Error(`Inserted verification code ${resolvedId} could not be read back.`);
      }

      this.database.exec("COMMIT");
      return mapMailVerificationRow(row, nowMs);
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Ignore rollback failure after statement abort.
      }
      throw error;
    }
  }

  public async deleteMailVerificationCodesForMessage(messageId: string): Promise<number> {
    const result = this.database.prepare(
      "DELETE FROM mail_verification_codes WHERE message_id = ?",
    ).run(messageId);
    return Number(result.changes);
  }

  public async listMailVerificationCodes(
    query: MailVerificationListQuery,
    nowMs: number,
  ): Promise<MailVerificationRecord[]> {
    const conditions = ["m.deleted_at IS NULL"];
    const params: SQLInputValue[] = [];

    if (query.sessionId) {
      conditions.push("v.session_id = ?");
      params.push(query.sessionId);
    }

    if (query.scope && query.scope !== "all") {
      conditions.push("v.account_scope = ?");
      params.push(query.scope);
    } else {
      conditions.push("v.account_scope != 'agent'");
    }

    const requestedLimit = query.limit ?? 50;
    const sqlLimit = query.freshOnly ? Math.min(requestedLimit * 4, 400) : requestedLimit;
    params.push(sqlLimit);

    const rows = this.database.prepare(`
      SELECT ${VERIFICATION_SELECT_COLUMNS}
      FROM mail_verification_codes v
      INNER JOIN mail_messages m ON m.id = v.message_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY v.extracted_at DESC, v.id DESC
      LIMIT ?
    `).all(...params) as unknown as RawMailVerificationRow[];

    const mapped = rows.map((row) => mapMailVerificationRow(row, nowMs));
    if (!query.freshOnly) {
      return mapped.slice(0, requestedLimit);
    }
    return mapped.filter((item) => item.isFresh).slice(0, requestedLimit);
  }
}
