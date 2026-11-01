import type { EasyEmailHttpClientOptions } from "./easyEmailCoreTypes.ts";
import { createEasyEmailContactResources } from "./easyEmailContactResources.ts";
import { createEasyEmailMailboxResources } from "./easyEmailMailboxResources.ts";
import { createEasyEmailMailResources } from "./easyEmailMailResources.ts";
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
  EasyEmailMailTaxonomyKind,
  EasyEmailMailTaxonomyItem,
  EasyEmailMailTaxonomyCapabilities,
  EasyEmailMailTaxonomyListQuery,
  EasyEmailMailTaxonomyListResponse,
  EasyEmailMailTaxonomyUpsertRequest,
  EasyEmailMailTaxonomyUpdateRequest,
  EasyEmailMailTaxonomyMutationResponse,
  EasyEmailMailTaxonomyDeleteResponse,
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

export { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";
export { EasyEmailHttpError, normalizeEasyEmailHttpBaseUrl } from "./easyEmailHttpTransport.ts";

export function createEasyEmailHttpClient(options: EasyEmailHttpClientOptions) {
  const request = createEasyEmailRequestTransport(options);
  return {
    request,
    ...createEasyEmailContactResources(request),
    ...createEasyEmailMailResources(request),
    ...createEasyEmailMailboxResources(request),
  };
}

export type EasyEmailHttpClient = ReturnType<typeof createEasyEmailHttpClient>;
