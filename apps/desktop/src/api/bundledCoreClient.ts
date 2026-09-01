import type { InvokeCommand } from "./invokeCommand";
import { createDesktopCoreClient } from "./desktopCoreClient.ts";
import {
  createEasyEmailHttpClient,
  type EasyEmailAuthenticationLinkResponse,
  type EasyEmailAuthenticationLinkResult,
  type EasyEmailCatalogResponse,
  type EasyEmailMailboxOutcomeRequest,
  type EasyEmailMailboxSendRequest,
  type EasyEmailMailboxSession,
  type EasyEmailMailboxSessionQuery,
  type EasyEmailMailboxSessionsResponse,
  type EasyEmailMailboxUpdateRequest,
  type EasyEmailObservedMessage,
  type EasyEmailObservedMessageResponse,
  type EasyEmailObservedMessagesResponse,
  type EasyEmailObservedMessageQuery,
  type EasyEmailOpenMailboxRequest,
  type EasyEmailOpenMailboxResponse,
  type EasyEmailPlanMailboxResponse,
  type EasyEmailProviderInstance,
  type EasyEmailProviderInstanceQuery,
  type EasyEmailProviderInstancesResponse,
  type EasyEmailRecoverMailboxRequest,
  type EasyEmailRecoverMailboxResponse,
  type EasyEmailReleaseMailboxResponse,
  type EasyEmailReportMailboxOutcomeResponse,
  type EasyEmailSendMailboxResponse,
  type EasyEmailUpdateMailboxResponse,
  type EasyEmailVerificationCodeResponse,
  type EasyEmailVerificationCodeResult,
  type EasyEmailVerificationMailboxOpenResult,
} from "./easyEmailHttpClient.ts";

export function createBundledCoreClient(
  invokeCommand: InvokeCommand,
  fetchRequest: typeof fetch = globalThis.fetch,
) {
  const desktopCoreClient = createDesktopCoreClient(invokeCommand);
  let runtimePromise: ReturnType<typeof desktopCoreClient.getRuntime> | undefined;
  let httpClientPromise:
    | Promise<ReturnType<typeof createEasyEmailHttpClient>>
    | undefined;

  function getRuntime() {
    if (!runtimePromise) {
      runtimePromise = desktopCoreClient.getRuntime().catch((error: unknown) => {
        runtimePromise = undefined;
        throw error;
      });
    }
    return runtimePromise;
  }

  function getHttpClient() {
    if (!httpClientPromise) {
      httpClientPromise = getRuntime()
        .then((runtime) =>
          createEasyEmailHttpClient({
            baseUrl: runtime.base_url,
            bearerToken: runtime.api_token,
            fetch: fetchRequest,
          }),
        )
        .catch((error: unknown) => {
          httpClientPromise = undefined;
          throw error;
        });
    }
    return httpClientPromise;
  }

  return {
    async getHostId(): Promise<string> {
      return (await getRuntime()).host_id;
    },
    async getCatalog<TCatalog = unknown>(): Promise<EasyEmailCatalogResponse<TCatalog>> {
      return (await getHttpClient()).getCatalog<TCatalog>();
    },
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
    async updateMailbox<TSession = EasyEmailMailboxSession>(
      request: EasyEmailMailboxUpdateRequest,
    ): Promise<EasyEmailUpdateMailboxResponse<TSession>> {
      return (await getHttpClient()).updateMailbox<TSession>(request);
    },
    async releaseMailbox<TResult = unknown>(
      request: { sessionId: string; reason?: string },
    ): Promise<EasyEmailReleaseMailboxResponse<TResult>> {
      return (await getHttpClient()).releaseMailbox<TResult>(request);
    },
    async recoverMailbox<TResult = unknown>(
      request: EasyEmailRecoverMailboxRequest,
    ): Promise<EasyEmailRecoverMailboxResponse<TResult>> {
      return (await getHttpClient()).recoverMailbox<TResult>(request);
    },
    async reportMailboxOutcome<TResult = unknown>(
      request: EasyEmailMailboxOutcomeRequest,
    ): Promise<EasyEmailReportMailboxOutcomeResponse<TResult>> {
      return (await getHttpClient()).reportMailboxOutcome<TResult>(request);
    },
    async sendMailboxMessage<TResult = unknown>(
      request: EasyEmailMailboxSendRequest,
    ): Promise<EasyEmailSendMailboxResponse<TResult>> {
      return (await getHttpClient()).sendMailboxMessage<TResult>(request);
    },
  };
}
