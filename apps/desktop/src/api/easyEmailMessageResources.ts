import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import type {
  EasyEmailMailDraftSaveRequest,
  EasyEmailMailDraftSaveResponse,
  EasyEmailMailMessageDetailQuery,
  EasyEmailMailMessageDetailResponse,
  EasyEmailMailMessageListQuery,
  EasyEmailMailMessageLocalActionResponse,
  EasyEmailMailMessageSetFlagRequest,
  EasyEmailMailMessageSetFolderRequest,
  EasyEmailMailMessageSetLabelRequest,
  EasyEmailMailMessagesResponse,
  EasyEmailMailPollVerificationResponse,
  EasyEmailMailReclassifyVerificationResponse,
  EasyEmailMailTrashEmptyRequest,
  EasyEmailMailTrashEmptyResponse,
  EasyEmailMailVerificationListQuery,
  EasyEmailMailVerificationsResponse,
} from "./easyEmailMessageTypes.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailMessageResources(request: EasyEmailRequestTransport) {
  return {
    listMailMessages(
      query: EasyEmailMailMessageListQuery = {},
    ): Promise<EasyEmailMailMessagesResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.messages, query });
    },
    getMailMessageDetail(
      messageId: string,
      query: EasyEmailMailMessageDetailQuery = {},
    ): Promise<EasyEmailMailMessageDetailResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.message(messageId), query });
    },
    saveLocalDraft(
      draftRequest: EasyEmailMailDraftSaveRequest,
    ): Promise<EasyEmailMailDraftSaveResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.drafts,
        body: draftRequest,
      });
    },
    deleteLocalDraft(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.draft(messageId),
      });
    },
    deleteMailMessageLocal(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.messageLocal(messageId),
      });
    },
    deleteMailMessageForever(messageId: string): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.message(messageId),
      });
    },
    emptyMailTrash(
      trashRequest: EasyEmailMailTrashEmptyRequest = {},
    ): Promise<EasyEmailMailTrashEmptyResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.trash,
        body: trashRequest,
      });
    },
    setMailMessageLocalFlag(
      messageId: string,
      flagRequest: EasyEmailMailMessageSetFlagRequest,
    ): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.messageFlags(messageId),
        body: flagRequest,
      });
    },
    setMailMessageLocalFolder(
      messageId: string,
      folderRequest: EasyEmailMailMessageSetFolderRequest,
    ): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.messageFolder(messageId),
        body: folderRequest,
      });
    },
    setMailMessageLocalLabel(
      messageId: string,
      labelRequest: EasyEmailMailMessageSetLabelRequest,
    ): Promise<EasyEmailMailMessageLocalActionResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.messageLabels(messageId),
        body: labelRequest,
      });
    },
    listMailVerifications(
      query: EasyEmailMailVerificationListQuery = {},
    ): Promise<EasyEmailMailVerificationsResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.verifications, query });
    },
    reclassifyMailMessageVerification(
      messageId: string,
    ): Promise<EasyEmailMailReclassifyVerificationResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.reclassifyMessageVerification(messageId),
        body: {},
      });
    },
    pollMailboxVerification(sessionId: string): Promise<EasyEmailMailPollVerificationResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.pollMailboxVerification(sessionId),
        body: {},
      });
    },
  };
}
