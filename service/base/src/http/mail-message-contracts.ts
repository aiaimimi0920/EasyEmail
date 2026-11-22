import type {
  MailDraftSaveInput,
  MailDraftSaveResult,
  MailMessageBatchActionResult,
  MailMessageDetail,
  MailMessageDetailScope,
  MailMessageListQuery,
  MailMessageLocalActionResult,
  MailMessageSetFlagInput,
  MailMessageSetFolderInput,
  MailMessageSetLabelInput,
  MailMessageSummary,
  MailTrashEmptyInput,
  MailVerificationListQuery,
  MailVerificationRecord,
} from "../domain/mail-message.js";
import type { MailboxRefreshResult } from "./contracts.js";

export type ListMailMessagesHttpRequest = MailMessageListQuery;
export interface ListMailMessagesHttpResponse {
  messages: MailMessageSummary[];
  nextCursor?: string;
}

export interface GetMailMessageDetailHttpRequest {
  scope?: MailMessageDetailScope;
  includeRawHtml?: boolean;
}

export interface GetMailMessageDetailHttpResponse {
  message: MailMessageDetail;
}

export type SaveMailDraftHttpRequest = MailDraftSaveInput;
export interface SaveMailDraftHttpResponse {
  draft: MailDraftSaveResult;
}

export interface MailMessageLocalActionHttpResponse {
  action: MailMessageLocalActionResult;
}

export type SetMailMessageFlagHttpRequest = MailMessageSetFlagInput;
export type SetMailMessageFolderHttpRequest = MailMessageSetFolderInput;
export type SetMailMessageLabelHttpRequest = MailMessageSetLabelInput;
export type EmptyMailTrashHttpRequest = MailTrashEmptyInput;

export interface EmptyMailTrashHttpResponse {
  result: MailMessageBatchActionResult;
}

export type ListMailVerificationsHttpRequest = MailVerificationListQuery;
export interface ListMailVerificationsHttpResponse {
  verifications: MailVerificationRecord[];
}

export interface ReclassifyMailMessageVerificationHttpResponse {
  verification?: MailVerificationRecord;
}

export interface PollMailboxVerificationHttpResponse {
  refresh: MailboxRefreshResult;
  detectedCode?: MailVerificationRecord;
}
