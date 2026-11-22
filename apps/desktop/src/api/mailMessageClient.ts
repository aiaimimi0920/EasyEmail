import type {
  AnonymousMessageDto,
  LocalDraftSaveDto,
  MessageBatchActionDto,
  MessageDetailDto,
  MessageLocalActionDto,
} from "../app/appTypes.ts";
import type { VerificationCodeDto } from "../mail/mailSearch.ts";
import {
  temporaryMailboxRefreshView,
  type TemporaryMailboxRefreshView,
} from "../mail/temporaryMailboxAdapter.ts";
import {
  EasyEmailHttpError,
  type EasyEmailMailDraftSaveRequest,
  type EasyEmailMailDraftSaveResponse,
  type EasyEmailMailMessageDetail,
  type EasyEmailMailMessageDetailQuery,
  type EasyEmailMailMessageDetailResponse,
  type EasyEmailMailMessageFlagName,
  type EasyEmailMailMessageListQuery,
  type EasyEmailMailMessageLocalActionResponse,
  type EasyEmailMailMessageLocalActionResult,
  type EasyEmailMailMessageSetFlagRequest,
  type EasyEmailMailMessageSetFolderRequest,
  type EasyEmailMailMessageSetLabelRequest,
  type EasyEmailMailMessagesResponse,
  type EasyEmailMailMessageSummary,
  type EasyEmailMailPollVerificationResponse,
  type EasyEmailMailReclassifyVerificationResponse,
  type EasyEmailMailTrashEmptyRequest,
  type EasyEmailMailTrashEmptyResponse,
  type EasyEmailMailVerificationListQuery,
  type EasyEmailMailVerificationRecord,
  type EasyEmailMailVerificationsResponse,
} from "./easyEmailHttpClient.ts";

export type LocalDraftSaveRequest = {
  draft_id: string | null;
  account_id: string;
  target_address: string;
  cc_addresses: string[];
  bcc_addresses: string[];
  subject: string;
  body_text: string;
  body_html: string;
};

export type VerificationPollDto = {
  refresh: TemporaryMailboxRefreshView;
  detected_code: VerificationCodeDto | null;
};

export interface MailMessageHttpTransport {
  listMailMessages(query?: EasyEmailMailMessageListQuery): Promise<EasyEmailMailMessagesResponse>;
  getMailMessageDetail(
    messageId: string,
    query?: EasyEmailMailMessageDetailQuery,
  ): Promise<EasyEmailMailMessageDetailResponse>;
  saveLocalDraft(request: EasyEmailMailDraftSaveRequest): Promise<EasyEmailMailDraftSaveResponse>;
  deleteLocalDraft(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse>;
  deleteMailMessageLocal(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse>;
  deleteMailMessageForever(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse>;
  emptyMailTrash(request?: EasyEmailMailTrashEmptyRequest): Promise<EasyEmailMailTrashEmptyResponse>;
  setMailMessageLocalFlag(
    messageId: string,
    request: EasyEmailMailMessageSetFlagRequest,
  ): Promise<EasyEmailMailMessageLocalActionResponse>;
  setMailMessageLocalFolder(
    messageId: string,
    request: EasyEmailMailMessageSetFolderRequest,
  ): Promise<EasyEmailMailMessageLocalActionResponse>;
  setMailMessageLocalLabel(
    messageId: string,
    request: EasyEmailMailMessageSetLabelRequest,
  ): Promise<EasyEmailMailMessageLocalActionResponse>;
  listMailVerifications(
    query?: EasyEmailMailVerificationListQuery,
  ): Promise<EasyEmailMailVerificationsResponse>;
  reclassifyMailMessageVerification(
    messageId: string,
  ): Promise<EasyEmailMailReclassifyVerificationResponse>;
  pollMailboxVerification(sessionId: string): Promise<EasyEmailMailPollVerificationResponse>;
}

function toMessageSummaryDto(summary: EasyEmailMailMessageSummary): AnonymousMessageDto {
  return {
    message_id: summary.id,
    thread_key: summary.threadKey ?? null,
    temp_mailbox_id: summary.sessionId ?? "",
    received_address: summary.receivedAddress,
    provider_label: summary.providerLabel,
    subject: summary.subject,
    from_address: summary.fromAddress,
    snippet: summary.snippet,
    observed_at: summary.observedAt,
    lifecycle_state: summary.lifecycleState,
    is_read: summary.isRead,
    is_starred: summary.isStarred,
    is_archived: summary.isArchived,
    is_important: summary.isImportant,
    local_folder: summary.localFolder,
    labels: summary.labels,
    newsletter_subscription_id: null,
  };
}

function toMessageDetailDto(detail: EasyEmailMailMessageDetail): MessageDetailDto {
  return {
    message_id: detail.id,
    account_id: detail.accountId ?? "",
    thread_key: detail.threadKey ?? null,
    received_address: detail.receivedAddress,
    subject: detail.subject,
    from_address: detail.fromAddress,
    snippet: detail.snippet,
    observed_at: detail.observedAt,
    body_text: detail.bodyText ?? null,
    body_html: detail.bodyHtml ?? null,
    body_cache_state: detail.bodyCacheState,
    draft_cc_addresses: detail.draftCcAddresses,
    draft_bcc_addresses: detail.draftBccAddresses,
    is_read: detail.isRead,
    is_starred: detail.isStarred,
    is_archived: detail.isArchived,
    is_important: detail.isImportant,
    local_folder: detail.localFolder,
    labels: detail.labels,
  };
}

function toLocalActionDto(action: EasyEmailMailMessageLocalActionResult): MessageLocalActionDto {
  return {
    message_id: action.messageId,
    changed: action.changed,
    status: action.status,
    remote_applied: action.remoteApplied,
  };
}

function toVerificationCodeDto(record: EasyEmailMailVerificationRecord): VerificationCodeDto {
  const accountScope = record.accountScope === "normal"
    ? "normal_account"
    : record.accountScope === "promoted"
      ? "promoted_account"
      : record.accountScope;
  return {
    id: record.id,
    message_id: record.messageId,
    temp_mailbox_id: record.sessionId ?? null,
    source_id: record.sourceRefId,
    account_scope: accountScope,
    received_address: record.receivedAddress,
    code: record.code,
    issuer_hint: record.issuerHint ?? null,
    target_service_hint: record.targetServiceHint ?? null,
    confidence: record.confidence,
    expires_at: record.expiresAt ?? null,
    extracted_at: record.extractedAt,
    subject: record.subject,
    from_address: record.fromAddress,
    observed_at: record.observedAt,
  };
}

export function isMessagesPersistenceUnavailableError(error: unknown): boolean {
  if (!(error instanceof EasyEmailHttpError) || error.status !== 503) {
    return false;
  }
  if (!error.payload || typeof error.payload !== "object") {
    return false;
  }
  const code = (error.payload as Record<string, unknown>).code;
  return (
    code === "MESSAGES_PERSISTENCE_UNAVAILABLE"
    || code === "VERIFICATIONS_PERSISTENCE_UNAVAILABLE"
  );
}

export function createMailMessageClient(transport: MailMessageHttpTransport) {
  async function paginateMessages(
    baseQuery: Omit<EasyEmailMailMessageListQuery, "cursor" | "limit">,
  ): Promise<AnonymousMessageDto[]> {
    const items: AnonymousMessageDto[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const response = await transport.listMailMessages({
        ...baseQuery,
        limit: 200,
        cursor,
      });
      items.push(...response.messages.map(toMessageSummaryDto));
      if (response.nextCursor && seenCursors.has(response.nextCursor)) {
        throw new Error("Message pagination returned a repeated cursor.");
      }
      if (response.nextCursor) {
        seenCursors.add(response.nextCursor);
      }
      cursor = response.nextCursor;
    } while (cursor);
    return items;
  }

  return {
    listAnonymousMessages(includeArchived = true): Promise<AnonymousMessageDto[]> {
      return paginateMessages({ scope: "anonymous", includeArchived });
    },

    listNormalAccountMessages(
      accountId: string,
      includeArchived = true,
    ): Promise<AnonymousMessageDto[]> {
      return paginateMessages({ scope: "normal_account", accountId, includeArchived });
    },

    listPromotedAccountMessages(
      accountId: string,
      includeArchived = true,
    ): Promise<AnonymousMessageDto[]> {
      return paginateMessages({ scope: "promoted_account", accountId, includeArchived });
    },

    async getMessageDetail(messageId: string): Promise<MessageDetailDto> {
      const response = await transport.getMailMessageDetail(messageId);
      return toMessageDetailDto(response.message);
    },

    async saveLocalDraft(request: LocalDraftSaveRequest): Promise<LocalDraftSaveDto> {
      const response = await transport.saveLocalDraft({
        draftId: request.draft_id,
        accountId: request.account_id,
        targetAddress: request.target_address,
        ccAddresses: request.cc_addresses,
        bccAddresses: request.bcc_addresses,
        subject: request.subject,
        bodyText: request.body_text,
        bodyHtml: request.body_html,
      });
      return {
        message_id: response.draft.messageId,
        saved_at: response.draft.savedAt,
      };
    },

    async deleteLocalDraft(draftId: string): Promise<MessageLocalActionDto> {
      try {
        const response = await transport.deleteLocalDraft(draftId);
        return toLocalActionDto(response.action);
      } catch (error: unknown) {
        if (error instanceof EasyEmailHttpError && error.status === 404) {
          return {
            message_id: draftId,
            changed: false,
            status: "not_found",
            remote_applied: false,
          };
        }
        throw error;
      }
    },

    async deleteMessageLocal(messageId: string): Promise<MessageLocalActionDto> {
      const response = await transport.deleteMailMessageLocal(messageId);
      return toLocalActionDto(response.action);
    },

    async deleteMessageForever(messageId: string): Promise<MessageLocalActionDto> {
      const response = await transport.deleteMailMessageForever(messageId);
      return toLocalActionDto(response.action);
    },

    async emptyTrash(messageIds: string[]): Promise<MessageBatchActionDto> {
      const response = await transport.emptyMailTrash({ messageIds });
      return {
        requested_count: response.result.requestedCount,
        changed_count: response.result.changedCount,
        remote_applied_count: response.result.remoteAppliedCount,
      };
    },

    async setMessageLocalFlag(
      messageId: string,
      flagName: EasyEmailMailMessageFlagName,
      enabled: boolean,
    ): Promise<MessageLocalActionDto> {
      const response = await transport.setMailMessageLocalFlag(messageId, {
        flagName,
        enabled,
      });
      return toLocalActionDto(response.action);
    },

    async setMessageLocalFolder(
      messageId: string,
      folderName: string,
    ): Promise<MessageLocalActionDto> {
      const response = await transport.setMailMessageLocalFolder(messageId, { folderName });
      return toLocalActionDto(response.action);
    },

    async setMessageLocalLabel(
      messageId: string,
      labelName: string,
      enabled: boolean,
    ): Promise<MessageLocalActionDto> {
      const response = await transport.setMailMessageLocalLabel(messageId, {
        labelName,
        enabled,
      });
      return toLocalActionDto(response.action);
    },

    async listRecentVerifications(
      tempMailboxId: string | null = null,
      limit = 100,
    ): Promise<VerificationCodeDto[]> {
      const response = await transport.listMailVerifications({
        sessionId: tempMailboxId ?? undefined,
        limit,
      });
      return response.verifications.map(toVerificationCodeDto);
    },

    async reclassifyMessageVerification(messageId: string): Promise<VerificationCodeDto | null> {
      const response = await transport.reclassifyMailMessageVerification(messageId);
      return response.verification ? toVerificationCodeDto(response.verification) : null;
    },

    async pollTempMailboxVerification(sessionId: string): Promise<VerificationPollDto> {
      const response = await transport.pollMailboxVerification(sessionId);
      return {
        refresh: temporaryMailboxRefreshView(response.refresh),
        detected_code: response.detectedCode ? toVerificationCodeDto(response.detectedCode) : null,
      };
    },
  };
}
