import type {
  EasyEmailAuthenticationLinkResponse,
  EasyEmailAuthenticationLinkResult,
  EasyEmailHttpClient,
  EasyEmailMailboxOutcomeRequest,
  EasyEmailMailboxOutcomeResult,
  EasyEmailMailboxRefreshResponse,
  EasyEmailMailboxSendRequest,
  EasyEmailMailboxSendResult,
  EasyEmailMailboxSession,
  EasyEmailMailboxSessionQuery,
  EasyEmailMailboxSessionsResponse,
  EasyEmailMailboxUpdateRequest,
  EasyEmailObservedMessage,
  EasyEmailObservedMessageQuery,
  EasyEmailObservedMessageResponse,
  EasyEmailObservedMessagesResponse,
  EasyEmailOpenMailboxRequest,
  EasyEmailOpenMailboxResponse,
  EasyEmailPlanMailboxResponse,
  EasyEmailProviderInstance,
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
  EasyEmailVerificationCodeResult,
  EasyEmailVerificationMailboxOpenResult,
} from "./easyEmailHttpClient.ts";

export function createBundledCoreMailboxMethods(
  getHttpClient: () => Promise<EasyEmailHttpClient>,
) {
  return {
    async planMailbox<TResult = unknown>(
      request: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailPlanMailboxResponse<TResult>> {
      return (await getHttpClient()).planMailbox<TResult>(request);
    },
    async openMailbox<TResult = EasyEmailVerificationMailboxOpenResult>(
      request: EasyEmailOpenMailboxRequest,
    ): Promise<EasyEmailOpenMailboxResponse<TResult>> {
      return (await getHttpClient()).openMailbox<TResult>(request);
    },
    async queryProviderInstances<TInstance = EasyEmailProviderInstance>(
      query: EasyEmailProviderInstanceQuery = {},
    ): Promise<EasyEmailProviderInstancesResponse<TInstance>> {
      return (await getHttpClient()).queryProviderInstances<TInstance>(query);
    },
    async queryMailboxSessions<TSession = EasyEmailMailboxSession>(
      query: EasyEmailMailboxSessionQuery,
    ): Promise<EasyEmailMailboxSessionsResponse<TSession>> {
      return (await getHttpClient()).queryMailboxSessions<TSession>(query);
    },
    async queryObservedMessages<TMessage = EasyEmailObservedMessage>(
      query: EasyEmailObservedMessageQuery,
    ): Promise<EasyEmailObservedMessagesResponse<TMessage>> {
      return (await getHttpClient()).queryObservedMessages<TMessage>(query);
    },
    async getObservedMessage<TMessage = EasyEmailObservedMessage>(
      messageId: string,
    ): Promise<EasyEmailObservedMessageResponse<TMessage>> {
      return (await getHttpClient()).getObservedMessage<TMessage>(messageId);
    },
    async readVerificationCode<TResult = EasyEmailVerificationCodeResult>(
      sessionId: string,
    ): Promise<EasyEmailVerificationCodeResponse<TResult>> {
      return (await getHttpClient()).readVerificationCode<TResult>(sessionId);
    },
    async readAuthenticationLink<TResult = EasyEmailAuthenticationLinkResult>(
      sessionId: string,
    ): Promise<EasyEmailAuthenticationLinkResponse<TResult>> {
      return (await getHttpClient()).readAuthenticationLink<TResult>(sessionId);
    },
    async refreshMailbox(sessionId: string): Promise<EasyEmailMailboxRefreshResponse> {
      return (await getHttpClient()).refreshMailbox(sessionId);
    },
    async refreshAnonymousMailboxes(hostId: string): Promise<EasyEmailMailboxRefreshResponse> {
      return (await getHttpClient()).refreshAnonymousMailboxes({ hostId });
    },
    async updateMailbox<TSession = EasyEmailMailboxSession>(
      request: EasyEmailMailboxUpdateRequest,
    ): Promise<EasyEmailUpdateMailboxResponse<TSession>> {
      return (await getHttpClient()).updateMailbox<TSession>(request);
    },
    async releaseMailbox<TResult = EasyEmailReleaseMailboxResult>(
      request: { sessionId: string; reason?: string },
    ): Promise<EasyEmailReleaseMailboxResponse<TResult>> {
      return (await getHttpClient()).releaseMailbox<TResult>(request);
    },
    async recoverMailbox<TResult = EasyEmailRecoverMailboxResult>(
      request: EasyEmailRecoverMailboxRequest,
    ): Promise<EasyEmailRecoverMailboxResponse<TResult>> {
      return (await getHttpClient()).recoverMailbox<TResult>(request);
    },
    async reportMailboxOutcome<TResult = EasyEmailMailboxOutcomeResult>(
      request: EasyEmailMailboxOutcomeRequest,
    ): Promise<EasyEmailReportMailboxOutcomeResponse<TResult>> {
      return (await getHttpClient()).reportMailboxOutcome<TResult>(request);
    },
    async sendMailboxMessage<TResult = EasyEmailMailboxSendResult>(
      request: EasyEmailMailboxSendRequest,
    ): Promise<EasyEmailSendMailboxResponse<TResult>> {
      return (await getHttpClient()).sendMailboxMessage<TResult>(request);
    },
  };
}
