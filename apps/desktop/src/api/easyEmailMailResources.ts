import type {
  EasyEmailMailAccountCreateRequest,
  EasyEmailMailAccountImapTestRequest,
  EasyEmailMailAccountImapTestResponse,
  EasyEmailMailAccountListQuery,
  EasyEmailMailAccountResponse,
  EasyEmailMailAccountsResponse,
  EasyEmailMailAccountSmtpTestRequest,
  EasyEmailMailAccountSmtpTestResponse,
  EasyEmailMailAccountSyncRequest,
  EasyEmailMailAccountUpdateRequest,
  EasyEmailGetMailAccountSyncStatusResponse,
  EasyEmailListMailAccountFoldersResponse,
  EasyEmailSyncMailAccountResponse,
  EasyEmailMailTaxonomyDeleteResponse,
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyUpsertRequest,
  EasyEmailGetEasyEmailSettingsResponse,
  EasyEmailListNewsletterSubscriptionsQuery,
  EasyEmailListNewsletterSubscriptionsResponse,
  EasyEmailPromoteMailboxRequest,
  EasyEmailPromoteMailboxResponse,
  EasyEmailTestEasyEmailConnectionRequest,
  EasyEmailTestEasyEmailConnectionResponse,
  EasyEmailUpdateEasyEmailSettingsRequest,
  EasyEmailUpdateEasyEmailSettingsResponse,
  EasyEmailUpdateNewsletterSubscriptionRequest,
  EasyEmailUpdateNewsletterSubscriptionResponse,
} from "./easyEmailMailTypes.ts";
import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailMailResources(request: EasyEmailRequestTransport) {
  return {
    listMailTaxonomy(
      query: EasyEmailMailTaxonomyListQuery,
    ): Promise<EasyEmailMailTaxonomyListResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.taxonomy, query });
    },
    getMailTaxonomy(itemId: string): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId) });
    },
    upsertMailTaxonomy(
      kind: EasyEmailMailTaxonomyKind,
      key: string,
      taxonomyRequest: EasyEmailMailTaxonomyUpsertRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({
        method: "PUT",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyUpsert(kind, key),
        body: taxonomyRequest,
      });
    },
    updateMailTaxonomy(
      itemId: string,
      taxonomyRequest: EasyEmailMailTaxonomyUpdateRequest,
    ): Promise<EasyEmailMailTaxonomyMutationResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId),
        body: taxonomyRequest,
      });
    },
    deleteMailTaxonomy(
      itemId: string,
      expectedVersion: number,
    ): Promise<EasyEmailMailTaxonomyDeleteResponse> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.taxonomyItem(itemId),
        query: { expectedVersion },
      });
    },
    listMailAccounts(
      query: EasyEmailMailAccountListQuery = {},
    ): Promise<EasyEmailMailAccountsResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.accounts, query });
    },
    getMailAccount(accountId: string): Promise<EasyEmailMailAccountResponse> {
      return request({ path: EASY_EMAIL_CORE_ROUTES.account(accountId) });
    },
    createMailAccount(
      accountRequest: EasyEmailMailAccountCreateRequest,
    ): Promise<EasyEmailMailAccountResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.accounts,
        body: accountRequest,
      });
    },
    updateMailAccount(
      accountId: string,
      accountRequest: EasyEmailMailAccountUpdateRequest,
    ): Promise<EasyEmailMailAccountResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.account(accountId),
        body: accountRequest,
      });
    },
    disableMailAccount(
      accountId: string,
      expectedVersion: number,
    ): Promise<EasyEmailMailAccountResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.disableAccount(accountId),
        body: { expectedVersion },
      });
    },
    deleteMailAccount(
      accountId: string,
      expectedVersion: number,
    ): Promise<{ deleted: { id: string } }> {
      return request({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.account(accountId),
        query: { expectedVersion },
      });
    },
    testMailAccountImap(
      testRequest: EasyEmailMailAccountImapTestRequest,
    ): Promise<EasyEmailMailAccountImapTestResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.testAccountImap,
        body: testRequest,
      });
    },
    testMailAccountSmtp(
      testRequest: EasyEmailMailAccountSmtpTestRequest,
    ): Promise<EasyEmailMailAccountSmtpTestResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.testAccountSmtp,
        body: testRequest,
      });
    },
    listMailAccountFolders(
      accountId: string,
      query: { refresh?: boolean } = {},
    ): Promise<EasyEmailListMailAccountFoldersResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.accountFolders(accountId),
        query,
      });
    },
    getMailAccountSyncStatus(
      accountId: string,
    ): Promise<EasyEmailGetMailAccountSyncStatusResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.accountSync(accountId),
      });
    },
    syncMailAccount(
      accountId: string,
      syncRequest: EasyEmailMailAccountSyncRequest = {},
    ): Promise<EasyEmailSyncMailAccountResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.accountSync(accountId),
        body: syncRequest,
      });
    },
    promoteMailbox(
      sessionId: string,
      promoteRequest: EasyEmailPromoteMailboxRequest,
    ): Promise<EasyEmailPromoteMailboxResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.promoteMailbox(sessionId),
        body: promoteRequest,
      });
    },
    listNewsletterSubscriptions(
      query: EasyEmailListNewsletterSubscriptionsQuery,
    ): Promise<EasyEmailListNewsletterSubscriptionsResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.newsletterSubscriptions,
        query,
      });
    },
    setNewsletterSubscriptionHidden(
      subscriptionId: string,
      updateRequest: EasyEmailUpdateNewsletterSubscriptionRequest,
    ): Promise<EasyEmailUpdateNewsletterSubscriptionResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.newsletterSubscription(subscriptionId),
        body: updateRequest,
      });
    },
    getEasyEmailSettings(): Promise<EasyEmailGetEasyEmailSettingsResponse> {
      return request({
        path: EASY_EMAIL_CORE_ROUTES.settingsEasyEmail,
      });
    },
    updateEasyEmailSettings(
      settingsRequest: EasyEmailUpdateEasyEmailSettingsRequest,
    ): Promise<EasyEmailUpdateEasyEmailSettingsResponse> {
      return request({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.settingsEasyEmail,
        body: settingsRequest,
      });
    },
    testEasyEmailConnection(
      testRequest: EasyEmailTestEasyEmailConnectionRequest = {},
    ): Promise<EasyEmailTestEasyEmailConnectionResponse> {
      return request({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.testSettingsEasyEmail,
        body: testRequest,
      });
    },
  };
}
