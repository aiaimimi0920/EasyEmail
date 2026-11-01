import type {
  EasyEmailAuthenticationLinkResult,
  EasyEmailMailboxSession,
  EasyEmailObservedMessage,
  EasyEmailProviderInstance,
  EasyEmailVerificationCodeResult,
  EasyEmailVerificationMailboxOpenResult,
} from "./easyEmailCoreTypes.ts";
import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import type {
  EasyEmailAuthenticationLinkResponse,
  EasyEmailMailboxOutcomeRequest,
  EasyEmailMailboxOutcomeResult,
  EasyEmailMailboxRefreshResponse,
  EasyEmailMailboxSendRequest,
  EasyEmailMailboxSendResult,
  EasyEmailMailboxSessionQuery,
  EasyEmailMailboxSessionsResponse,
  EasyEmailMailboxUpdateRequest,
  EasyEmailObservedMessageQuery,
  EasyEmailObservedMessageResponse,
  EasyEmailObservedMessagesResponse,
  EasyEmailOpenMailboxRequest,
  EasyEmailOpenMailboxResponse,
  EasyEmailPlanMailboxResponse,
  EasyEmailProviderInstanceQuery,
  EasyEmailProviderInstancesResponse,
  EasyEmailRecoverMailboxRequest,
  EasyEmailRecoverMailboxResponse,
  EasyEmailRecoverMailboxResult,
  EasyEmailReleaseMailboxResponse,
  EasyEmailReleaseMailboxResult,
  EasyEmailReportMailboxOutcomeResponse,
  EasyEmailSendMailboxResponse,
  EasyEmailUpdateMailboxResponse,
  EasyEmailVerificationCodeResponse,
} from "./easyEmailMailboxTypes.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailMailboxResources(request: EasyEmailRequestTransport) {
  return {
    planMailbox<TResult = unknown>(
      mailboxRequest: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailPlanMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.planMailbox,
        body: mailboxRequest,
      });
    },
    openMailbox<TResult = EasyEmailVerificationMailboxOpenResult>(
      mailboxRequest: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailOpenMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.openMailbox,
        body: mailboxRequest,
      });
    },
    queryProviderInstances<TInstance = EasyEmailProviderInstance>(
      query: EasyEmailProviderInstanceQuery = {},
    ): Promise<EasyEmailProviderInstancesResponse<TInstance>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryProviderInstances, query });
    },
    queryMailboxSessions<TSession = EasyEmailMailboxSession>(
      query: EasyEmailMailboxSessionQuery,
    ): Promise<EasyEmailMailboxSessionsResponse<TSession>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryMailboxSessions, query });
    },
    queryObservedMessages<TMessage = EasyEmailObservedMessage>(
      query: EasyEmailObservedMessageQuery,
    ): Promise<EasyEmailObservedMessagesResponse<TMessage>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.queryObservedMessages, query });
    },
    getObservedMessage<TMessage = EasyEmailObservedMessage>(
      messageId: string,
    ): Promise<EasyEmailObservedMessageResponse<TMessage>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.observedMessage(messageId) });
    },
    readVerificationCode<TResult = EasyEmailVerificationCodeResult>(
      sessionId: string,
    ): Promise<EasyEmailVerificationCodeResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.verificationCode(sessionId) });
    },
    readAuthenticationLink<TResult = EasyEmailAuthenticationLinkResult>(
      sessionId: string,
    ): Promise<EasyEmailAuthenticationLinkResponse<TResult>> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.authenticationLink(sessionId) });
    },
    refreshMailbox(sessionId: string): Promise<EasyEmailMailboxRefreshResponse> {
      return request({ method: "POST", path: EASY_EMAIL_CORE_ROUTES.refreshMailbox(sessionId) });
    },
    refreshAnonymousMailboxes(requestBody: {
      hostId: string;
    }): Promise<EasyEmailMailboxRefreshResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.refreshAnonymousMailboxes,
        body: requestBody,
      });
    },
    updateMailbox<TSession = EasyEmailMailboxSession>(
      updateRequest: EasyEmailMailboxUpdateRequest,
    ): Promise<EasyEmailUpdateMailboxResponse<TSession>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.updateMailbox,
        body: updateRequest,
      });
    },
    releaseMailbox<TResult = EasyEmailReleaseMailboxResult>(
      releaseRequest: { sessionId: string; reason?: string },
    ): Promise<EasyEmailReleaseMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.releaseMailbox,
        body: releaseRequest,
      });
    },
    recoverMailbox<TResult = EasyEmailRecoverMailboxResult>(
      recoverRequest: EasyEmailRecoverMailboxRequest,
    ): Promise<EasyEmailRecoverMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.recoverMailbox,
        body: recoverRequest,
      });
    },
    reportMailboxOutcome<TResult = EasyEmailMailboxOutcomeResult>(
      outcomeRequest: EasyEmailMailboxOutcomeRequest,
    ): Promise<EasyEmailReportMailboxOutcomeResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.reportMailboxOutcome,
        body: outcomeRequest,
      });
    },
    sendMailboxMessage<TResult = EasyEmailMailboxSendResult>(
      sendRequest: EasyEmailMailboxSendRequest,
    ): Promise<EasyEmailSendMailboxResponse<TResult>> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.sendMailboxMessage,
        body: sendRequest,
      });
    },
  };
}
