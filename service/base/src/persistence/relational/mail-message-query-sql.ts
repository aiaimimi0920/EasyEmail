import type { SQLInputValue } from "node:sqlite";

import type {
  MailMessageDetailScope,
  MailMessageListScope,
  MailMessageRepositoryListQuery,
} from "../../domain/mail-message.js";

export const MESSAGE_SELECT_COLUMNS = `
  m.id,
  m.rfc_message_id,
  m.thread_key,
  m.subject,
  m.from_address,
  m.from_name,
  m.snippet,
  m.body_text,
  m.body_html,
  m.body_cache_state,
  m.has_attachments,
  m.classification,
  m.newsletter_list_id,
  m.observed_at,
  m.version,
  s.source_kind,
  s.source_ref_id,
  s.account_id,
  s.session_id,
  s.provider_instance_id,
  s.external_message_id,
  s.received_address,
  s.provider_label,
  s.lifecycle_state,
  s.is_read,
  s.is_starred,
  s.is_archived,
  s.is_important,
  s.local_folder,
  s.labels_json,
  s.draft_cc_json,
  s.draft_bcc_json
`;

function buildSourceScopePredicate(
  scope: MailMessageListScope,
  accountId: string | undefined,
  sessionId: string | undefined,
  params: SQLInputValue[],
): string {
  const parts: string[] = [];
  if (scope === "anonymous") {
    parts.push("s2.source_kind = 'temporary_session'", "s2.account_id IS NULL");
  } else if (scope === "normal_account") {
    parts.push(
      "s2.account_id = ?",
      "a2.deleted_at IS NULL",
      "a2.scope = 'normal'",
    );
    params.push(accountId ?? "");
  } else if (scope === "promoted_account") {
    parts.push(
      "s2.account_id = ?",
      "s2.session_id IS NOT NULL",
      "a2.deleted_at IS NULL",
      "a2.scope = 'normal'",
    );
    params.push(accountId ?? "");
  } else if (scope === "agent_account") {
    parts.push(
      "s2.account_id = ?",
      "a2.deleted_at IS NULL",
      "a2.scope = 'agent'",
    );
    params.push(accountId ?? "");
  } else {
    parts.push(
      "((s2.source_kind = 'temporary_session' AND s2.account_id IS NULL)"
        + " OR (s2.account_id IS NOT NULL AND a2.deleted_at IS NULL AND a2.scope = 'normal' AND a2.listed_in_all_accounts = 1))",
    );
    if (accountId) {
      parts.push("s2.account_id = ?");
      params.push(accountId);
    }
  }

  if (sessionId) {
    parts.push("s2.session_id = ?");
    params.push(sessionId);
  }

  return parts.join(" AND ");
}

export function buildListMailMessagesSql(query: MailMessageRepositoryListQuery): {
  sql: string;
  params: SQLInputValue[];
} {
  const params: SQLInputValue[] = [];
  const sourceScopeSql = buildSourceScopePredicate(
    query.scope,
    query.accountId,
    query.sessionId,
    params,
  );

  const whereParts: string[] = [
    "m.deleted_at IS NULL",
    `s.id = (
      SELECT s2.id
      FROM mail_message_sources s2
      LEFT JOIN mail_accounts a2 ON a2.id = s2.account_id
      WHERE s2.message_id = m.id
        AND ${sourceScopeSql}
      ORDER BY s2.first_seen_at ASC, s2.id ASC
      LIMIT 1
    )`,
  ];

  if (!query.includeArchived) {
    whereParts.push("s.is_archived = 0");
  }

  if (query.folder) {
    whereParts.push("lower(s.local_folder) = ?");
    params.push(query.folder.trim().toLowerCase());
  }

  if (query.label) {
    whereParts.push(
      "EXISTS (SELECT 1 FROM json_each(s.labels_json) lbl WHERE lower(CAST(lbl.value AS TEXT)) = ?)",
    );
    params.push(query.label.trim().toLowerCase());
  }

  if (query.search) {
    const escaped = query.search.trim().toLowerCase().replace(/[\\%_]/g, "\\$&");
    const likePattern = `%${escaped}%`;
    whereParts.push(
      "(lower(m.subject) LIKE ? ESCAPE '\\'"
        + " OR lower(m.from_address) LIKE ? ESCAPE '\\'"
        + " OR lower(s.received_address) LIKE ? ESCAPE '\\'"
        + " OR lower(m.snippet) LIKE ? ESCAPE '\\')",
    );
    params.push(likePattern, likePattern, likePattern, likePattern);
  }

  if (query.after) {
    whereParts.push("(m.observed_at < ? OR (m.observed_at = ? AND m.id < ?))");
    params.push(query.after.observedAt, query.after.observedAt, query.after.id);
  }

  params.push(query.limit + 1);

  const sql = `
    SELECT ${MESSAGE_SELECT_COLUMNS}
    FROM mail_messages m
    INNER JOIN mail_message_sources s ON s.message_id = m.id
    WHERE ${whereParts.join(" AND ")}
    ORDER BY m.observed_at DESC, m.id DESC
    LIMIT ?
  `;

  return { sql, params };
}

export function buildDetailSourceScopeCondition(scope: MailMessageDetailScope): string {
  if (scope === "agent") {
    return "s2.account_id IS NOT NULL AND a2.deleted_at IS NULL AND a2.scope = 'agent'";
  }
  if (scope === "all") {
    return "s2.account_id IS NULL OR a2.deleted_at IS NULL";
  }
  return "s2.account_id IS NULL OR (a2.deleted_at IS NULL AND a2.scope != 'agent')";
}
