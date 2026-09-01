import type {
  EasyEmailMailboxSession,
  EasyEmailMailboxRefreshResult,
  EasyEmailObservedMessage,
  EasyEmailProviderInstance,
  EasyEmailVerificationCodeResult,
  EasyEmailVerificationMailboxOpenResult,
} from "../api/easyEmailHttpClient.ts";

export type TemporaryMailboxView = {
  id: string;
  email_address: string;
  provider_id: string;
  provider_label: string;
  visibility_state: "anonymous";
  lifecycle_state: "active" | "history_only" | "expired";
  easyemail_mailbox_id: string;
  lease_expires_at: string | null;
  created_at: string;
  updated_at: string;
};

export type TemporaryMailboxRecord = {
  view: TemporaryMailboxView;
  access: EasyEmailVerificationMailboxOpenResult;
};

export type TemporaryObservedMessageView = {
  message_id: string;
  thread_key: null;
  temp_mailbox_id: string;
  received_address: string;
  provider_label: string;
  subject: string;
  from_address: string;
  snippet: string;
  observed_at: string;
  lifecycle_state: TemporaryMailboxView["lifecycle_state"];
  is_read: false;
  is_starred: false;
  is_archived: false;
  is_important: false;
  local_folder: "inbox";
  labels: string[];
  newsletter_subscription_id: null;
};

export type TemporaryVerificationCodeView = {
  id: string;
  message_id: string;
  temp_mailbox_id: string;
  source_id: string;
  account_scope: "anonymous";
  received_address: string;
  code: string;
  issuer_hint: null;
  target_service_hint: string | null;
  confidence: 1;
  expires_at: null;
  extracted_at: string;
  subject: string;
  from_address: string;
  observed_at: string;
};

export type TemporaryMailboxRefreshView = {
  fetched_count: number;
  inserted_count: number;
  skipped_count: number;
  failed_count: number;
  refreshed_mailbox_ids: string[];
  skipped_mailbox_ids: string[];
  failures: Array<{
    temp_mailbox_id: string;
    error_code: string;
  }>;
};

function lifecycleState(
  status: EasyEmailMailboxSession["status"],
): TemporaryMailboxView["lifecycle_state"] {
  if (status === "expired") return "expired";
  if (status === "resolved") return "history_only";
  return "active";
}

function providerLabel(
  session: EasyEmailMailboxSession,
  instance?: Pick<EasyEmailProviderInstance, "id" | "displayName">,
): string {
  if (instance?.displayName) return instance.displayName;
  return session.metadata.providerLabel ?? session.providerTypeKey;
}

export function temporaryMailboxViewFromSession(
  session: EasyEmailMailboxSession,
  instance?: Pick<EasyEmailProviderInstance, "id" | "displayName">,
): TemporaryMailboxView {
  return {
    id: session.id,
    email_address: session.emailAddress,
    provider_id: instance?.id ?? session.providerInstanceId,
    provider_label: providerLabel(session, instance),
    visibility_state: "anonymous",
    lifecycle_state: lifecycleState(session.status),
    easyemail_mailbox_id: session.id,
    lease_expires_at: session.expiresAt ?? null,
    created_at: session.createdAt,
    updated_at: session.metadata.updatedAt ?? session.createdAt,
  };
}

export function temporaryMailboxRecordFromOpenResult(
  result: EasyEmailVerificationMailboxOpenResult,
): TemporaryMailboxRecord {
  return {
    view: temporaryMailboxViewFromSession(result.session, result.instance),
    access: result,
  };
}

export function temporaryMailboxRefreshView(
  refresh: EasyEmailMailboxRefreshResult,
): TemporaryMailboxRefreshView {
  return {
    fetched_count: refresh.fetchedCount,
    inserted_count: refresh.insertedCount,
    skipped_count: refresh.skippedCount,
    failed_count: refresh.failedCount,
    refreshed_mailbox_ids: refresh.refreshedSessionIds,
    skipped_mailbox_ids: refresh.skippedSessionIds,
    failures: refresh.failures.map((failure) => ({
      temp_mailbox_id: failure.sessionId,
      error_code: failure.errorCode,
    })),
  };
}

export function temporaryMailboxRefreshFailureMessage(
  refresh: TemporaryMailboxRefreshView,
): string | null {
  if (refresh.failed_count === 0) return null;
  const failures = refresh.failures
    .map((failure) => `${failure.temp_mailbox_id} (${failure.error_code})`)
    .join(", ");
  return failures
    ? `Refresh failed for ${refresh.failed_count} mailbox(es): ${failures}.`
    : `Refresh failed for ${refresh.failed_count} mailbox(es).`;
}

function messageSnippet(message: EasyEmailObservedMessage): string {
  const body = message.textBody ?? message.subject ?? "";
  return body.replace(/\s+/g, " ").trim().slice(0, 240);
}

export function temporaryObservedMessageView(
  message: EasyEmailObservedMessage,
  mailbox: TemporaryMailboxView,
): TemporaryObservedMessageView {
  return {
    message_id: message.id,
    thread_key: null,
    temp_mailbox_id: message.sessionId,
    received_address: mailbox.email_address,
    provider_label: mailbox.provider_label,
    subject: message.subject ?? "(no subject)",
    from_address: message.sender ?? "",
    snippet: messageSnippet(message),
    observed_at: message.observedAt,
    lifecycle_state: mailbox.lifecycle_state,
    is_read: false,
    is_starred: false,
    is_archived: false,
    is_important: false,
    local_folder: "inbox",
    labels: [],
    newsletter_subscription_id: null,
  };
}

export function temporaryVerificationCodeView(
  code: EasyEmailVerificationCodeResult,
  mailbox: TemporaryMailboxView,
  message?: EasyEmailObservedMessage,
): TemporaryVerificationCodeView {
  return {
    id: `core:${code.sessionId}:${code.observedMessageId}`,
    message_id: code.observedMessageId,
    temp_mailbox_id: code.sessionId,
    source_id: code.providerInstanceId,
    account_scope: "anonymous",
    received_address: mailbox.email_address,
    code: code.code,
    issuer_hint: null,
    target_service_hint: null,
    confidence: 1,
    expires_at: null,
    extracted_at: code.receivedAt,
    subject: message?.subject ?? "",
    from_address: message?.sender ?? "",
    observed_at: message?.observedAt ?? code.receivedAt,
  };
}
