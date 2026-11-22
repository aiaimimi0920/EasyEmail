import type { EasyEmailHttpClientOptions } from "./easyEmailCoreTypes.ts";
import { createEasyEmailAgentResources } from "./easyEmailAgentResources.ts";
import { createEasyEmailContactResources } from "./easyEmailContactResources.ts";
import { createEasyEmailMailboxResources } from "./easyEmailMailboxResources.ts";
import { createEasyEmailMailResources } from "./easyEmailMailResources.ts";
import { createEasyEmailMessageResources } from "./easyEmailMessageResources.ts";
import { createEasyEmailSendQueueResources } from "./easyEmailSendQueueResources.ts";
import { createEasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";

export type {
  EasyEmailHttpQuery,
  EasyEmailHttpRequest,
  EasyEmailHttpClientOptions,
  EasyEmailMailboxSessionStatus,
  EasyEmailCodeSource,
  EasyEmailMailboxSession,
  EasyEmailProviderInstance,
  EasyEmailHostBinding,
  EasyEmailTemporaryAuthCredential,
  EasyEmailRecoveryRequiredFields,
  EasyEmailCreatedByProvider,
  EasyEmailVerificationMailboxOpenResult,
  EasyEmailActionLinkCandidate,
  EasyEmailObservedMessage,
  EasyEmailVerificationCodeResult,
  EasyEmailAuthenticationLinkResult,
  EasyEmailCatalogResponse,
  EasyEmailContact,
  EasyEmailContactCreateRequest,
  EasyEmailContactUpdateRequest,
  EasyEmailContactListQuery,
  EasyEmailContactsResponse,
  EasyEmailContactResponse,
  EasyEmailContactDeleteResponse,
} from "./easyEmailCoreTypes.ts";

export type {
  EasyEmailMailAccountScope,
  EasyEmailMailAccountKind,
  EasyEmailMailAccountCreatableKind,
  EasyEmailMailAccountImapSecurity,
  EasyEmailMailAccountImapProfile,
  EasyEmailMailAccountImapProfileInput,
  EasyEmailMailAccountSmtpSecurity,
  EasyEmailMailAccountSmtpProfile,
  EasyEmailMailAccountSmtpProfileInput,
  EasyEmailMailAccountStatus,
  EasyEmailMailAccountAuthStatus,
  EasyEmailMailAccountReceiveStatus,
  EasyEmailMailAccountSendStatus,
  EasyEmailMailAccount,
  EasyEmailMailAccountListQuery,
  EasyEmailMailAccountCreateRequest,
  EasyEmailMailAccountUpdateRequest,
  EasyEmailMailAccountsResponse,
  EasyEmailMailAccountResponse,
  EasyEmailMailAccountImapTestRequest,
  EasyEmailMailAccountImapTestResponse,
  EasyEmailMailAccountSmtpTestRequest,
  EasyEmailMailAccountSmtpTestResponse,
  EasyEmailMailImapFolderKind,
  EasyEmailMailAccountSyncState,
  EasyEmailMailImapFolder,
  EasyEmailMailAccountSyncStatus,
  EasyEmailMailAccountSyncRequest,
  EasyEmailMailAccountFolderSyncSummary,
  EasyEmailMailAccountSyncResult,
  EasyEmailListMailAccountFoldersResponse,
  EasyEmailGetMailAccountSyncStatusResponse,
  EasyEmailSyncMailAccountResponse,
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyItem,
  EasyEmailMailTaxonomyCapabilities,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyUpsertRequest,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyDeleteResponse,
  EasyEmailPromoteMailboxRequest,
  EasyEmailPromoteMailboxResponse,
  EasyEmailNewsletterSubscription,
  EasyEmailListNewsletterSubscriptionsQuery,
  EasyEmailListNewsletterSubscriptionsResponse,
  EasyEmailUpdateNewsletterSubscriptionRequest,
  EasyEmailNewsletterSubscriptionActionResult,
  EasyEmailUpdateNewsletterSubscriptionResponse,
  EasyEmailClientSettings,
  EasyEmailGetEasyEmailSettingsResponse,
  EasyEmailUpdateEasyEmailSettingsRequest,
  EasyEmailUpdateEasyEmailSettingsResponse,
  EasyEmailTestEasyEmailConnectionRequest,
  EasyEmailConnectionHealth,
  EasyEmailTestEasyEmailConnectionResponse,
} from "./easyEmailMailTypes.ts";

export type {
  EasyEmailPlanMailboxResponse,
  EasyEmailOpenMailboxResponse,
  EasyEmailMailboxSessionsResponse,
  EasyEmailProviderInstancesResponse,
  EasyEmailObservedMessagesResponse,
  EasyEmailObservedMessageResponse,
  EasyEmailVerificationCodeResponse,
  EasyEmailAuthenticationLinkResponse,
  EasyEmailMailboxRefreshFailure,
  EasyEmailMailboxRefreshResult,
  EasyEmailMailboxRefreshResponse,
  EasyEmailReleaseMailboxResult,
  EasyEmailReleaseMailboxResponse,
  EasyEmailUpdateMailboxResponse,
  EasyEmailMailboxSendResult,
  EasyEmailSendMailboxResponse,
  EasyEmailRecoverMailboxResult,
  EasyEmailRecoverMailboxResponse,
  EasyEmailMailboxOutcomeResult,
  EasyEmailReportMailboxOutcomeResponse,
  EasyEmailOpenMailboxRequest,
  EasyEmailMailboxSessionQuery,
  EasyEmailProviderInstanceQuery,
  EasyEmailObservedMessageQuery,
  EasyEmailMailboxUpdateRequest,
  EasyEmailMailboxSendRequest,
  EasyEmailRecoverMailboxRequest,
  EasyEmailMailboxOutcomeRequest,
} from "./easyEmailMailboxTypes.ts";

export type * from "./easyEmailMessageTypes.ts";
export type * from "./easyEmailSendQueueTypes.ts";
export type * from "./easyEmailAgentTypes.ts";

export { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";
export { EasyEmailHttpError, normalizeEasyEmailHttpBaseUrl } from "./easyEmailHttpTransport.ts";

export function createEasyEmailHttpClient(options: EasyEmailHttpClientOptions) {
  const request = createEasyEmailRequestTransport(options);
  return {
    request,
    ...createEasyEmailContactResources(request),
    ...createEasyEmailMailResources(request),
    ...createEasyEmailMessageResources(request),
    ...createEasyEmailSendQueueResources(request),
    ...createEasyEmailAgentResources(request),
    ...createEasyEmailMailboxResources(request),
  };
}

export type EasyEmailHttpClient = ReturnType<typeof createEasyEmailHttpClient>;
