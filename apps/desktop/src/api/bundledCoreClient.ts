import type { InvokeCommand } from "./invokeCommand";
import { createDesktopCoreClient } from "./desktopCoreClient.ts";
import {
  createEasyEmailHttpClient,
  type EasyEmailAuthenticationLinkResponse,
  type EasyEmailAuthenticationLinkResult,
  type EasyEmailCatalogResponse,
  type EasyEmailContact,
  type EasyEmailContactCreateRequest,
  type EasyEmailContactListQuery,
  type EasyEmailContactResponse,
  type EasyEmailContactsResponse,
  type EasyEmailMailboxOutcomeRequest,
  type EasyEmailMailboxOutcomeResult,
  type EasyEmailMailboxRefreshResponse,
  type EasyEmailMailboxSendResult,
  type EasyEmailMailboxSendRequest,
  type EasyEmailMailboxSession,
  type EasyEmailMailboxSessionQuery,
  type EasyEmailMailboxSessionsResponse,
  type EasyEmailMailboxUpdateRequest,
  type EasyEmailMailTaxonomyDeleteResponse,
  type EasyEmailMailTaxonomyKind,
  type EasyEmailMailTaxonomyListQuery,
  type EasyEmailMailTaxonomyListResponse,
  type EasyEmailMailTaxonomyMutationResponse,
  type EasyEmailMailTaxonomyUpdateRequest,
  type EasyEmailMailTaxonomyUpsertRequest,
  type EasyEmailMailAccountCreateRequest,
  type EasyEmailMailAccountImapTestRequest,
  type EasyEmailMailAccountImapTestResponse,
  type EasyEmailMailAccountListQuery,
  type EasyEmailMailAccountResponse,
  type EasyEmailMailAccountsResponse,
  type EasyEmailMailAccountUpdateRequest,
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
  type EasyEmailRecoverMailboxResult,
  type EasyEmailRecoverMailboxResponse,
  type EasyEmailReleaseMailboxResult,
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
    async listContacts<TContact = EasyEmailContact>(
      query: EasyEmailContactListQuery = {},
    ): Promise<EasyEmailContactsResponse<TContact>> {
      return (await getHttpClient()).listContacts<TContact>(query);
    },
    async createContact<TContact = EasyEmailContact>(
      request: EasyEmailContactCreateRequest,
    ): Promise<EasyEmailContactResponse<TContact>> {
      return (await getHttpClient()).createContact<TContact>(request);
    },
    async listMailTaxonomy(
      query: EasyEmailMailTaxonomyListQuery,
    ): Promise<EasyEmailMailTaxonomyListResponse> {
      return (await getHttpClient()).listMailTaxonomy(query);
    },
    async listMailAccounts(query: EasyEmailMailAccountListQuery = {}): Promise<EasyEmailMailAccountsResponse> {
      return (await getHttpClient()).listMailAccounts(query);
    },
    async getMailAccount(accountId: string): Promise<EasyEmailMailAccountResponse> {
      return (await getHttpClient()).getMailAccount(accountId);
    },
    async createMailAccount(request: EasyEmailMailAccountCreateRequest): Promise<EasyEmailMailAccountResponse> {
      return (await getHttpClient()).createMailAccount(request);
    },
    async updateMailAccount(accountId: string, request: EasyEmailMailAccountUpdateRequest): Promise<EasyEmailMailAccountResponse> {
      return (await getHttpClient()).updateMailAccount(accountId, request);
    },
    async disableMailAccount(accountId: string, expectedVersion: number): Promise<EasyEmailMailAccountResponse> {
      return (await getHttpClient()).disableMailAccount(accountId, expectedVersion);
    },
    async deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ deleted: { id: string } }> {
      return (await getHttpClient()).deleteMailAccount(accountId, expectedVersion);
    },
    async testMailAccountImap(request: EasyEmailMailAccountImapTestRequest): Promise<EasyEmailMailAccountImapTestResponse> {
      return (await getHttpClient()).testMailAccountImap(request);
    },
    async getMailTaxonomy(itemId: string): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return (await getHttpClient()).getMailTaxonomy(itemId);
    },
    async upsertMailTaxonomy(
      kind: EasyEmailMailTaxonomyKind,
      key: string,
      request: EasyEmailMailTaxonomyUpsertRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return (await getHttpClient()).upsertMailTaxonomy(kind, key, request);
    },
    async updateMailTaxonomy(
      itemId: string,
      request: EasyEmailMailTaxonomyUpdateRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return (await getHttpClient()).updateMailTaxonomy(itemId, request);
    },
    async deleteMailTaxonomy(
      itemId: string,
      expectedVersion: number,
    ): Promise<EasyEmailMailTaxonomyDeleteResponse> {
      return (await getHttpClient()).deleteMailTaxonomy(itemId, expectedVersion);
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
