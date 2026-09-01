import type { CredentialSetDefinition } from "../shared/index.js";
import type {
  Contact,
  ContactCreateInput,
  ContactDeleteInput,
  ContactListQuery,
  ContactUpdateInput,
} from "../domain/contact.js";
import type {
  MailTaxonomyCapabilities,
  MailTaxonomyDeleteRequest,
  MailTaxonomyItem,
  MailTaxonomyListQuery,
  MailTaxonomyUpdateRequest,
  MailTaxonomyUpsertRequest,
} from "../domain/mail-taxonomy.js";
import type {
  AuthenticationLinkResult,
  HostBinding,
  HostBindingQueryFilters,
  MailPersistenceStats,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSessionUpdateRequest,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSession,
  MailboxAccessDescriptor,
  MailboxSessionQueryFilters,
  MailProviderTypeKey,
  ObserveMessageInput,
  ObservedMessage,
  ObservedMessageQueryFilters,
  ProviderCredentialBinding,
  ProviderCredentialSet,
  ProviderHealthProbeResult,
  ProviderInstance,
  ProviderInstanceQueryFilters,
  RegisterCloudflareTempEmailRuntimeRequest,
  RegisterCloudflareTempEmailRuntimeResult,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";
import type { MessageCleanupRecord } from "../workers/cleanup-messages.js";
import type { SessionExpiryRecord } from "../workers/expire-sessions.js";
import type { HealthRefreshRecord } from "../workers/refresh-instance-health.js";

export interface EasyEmailMaintenanceResult {
  expired: SessionExpiryRecord[];
  cleaned: MessageCleanupRecord[];
  refreshed: HealthRefreshRecord[];
}

export const EASY_EMAIL_HTTP_ROUTES = {
  catalog: "/mail/catalog",
  snapshot: "/mail/snapshot",
  registerCloudflareTempEmailRuntime: "/mail/providers/cloudflare_temp_email/register",
  applyCredentialSets: "/mail/providers/credentials/apply",
  probeAllProviderInstances: "/mail/providers/probe-all",
  queryProviderInstances: "/mail/query/provider-instances",
  queryHostBindings: "/mail/query/host-bindings",
  queryMailboxSessions: "/mail/query/mailbox-sessions",
  queryObservedMessages: "/mail/query/observed-messages",
  persistenceStats: "/mail/query/stats",
  contacts: "/mail/contacts",
  taxonomy: "/mail/taxonomy",
  planMailbox: "/mail/mailboxes/plan",
  openMailbox: "/mail/mailboxes/open",
  refreshAnonymousMailboxes: "/mail/mailboxes/anonymous/refresh",
  sendMailboxMessage: "/mail/mailboxes/send",
  updateMailboxSession: "/mail/mailboxes/update-session",
  releaseMailbox: "/mail/mailboxes/release",
  recoverMailboxByEmail: "/mail/mailboxes/recover-by-email",
  recoverMailboxCapacity: "/mail/mailboxes/recover-capacity",
  cleanupMoemailMailboxes: "/mail/providers/moemail/cleanup",
  reportMailboxOutcome: "/mail/mailboxes/report-outcome",
  observeMessage: "/mail/messages/observe",
  runMaintenance: "/mail/maintenance/run",
  probeProviderInstance(instanceId: string): string {
    return `/mail/providers/${encodeURIComponent(instanceId)}/probe`;
  },
  readVerificationCode(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/code`;
  },
  readAuthenticationLink(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/auth-link`;
  },
  refreshMailbox(sessionId: string): string {
    return `/mail/mailboxes/${encodeURIComponent(sessionId)}/refresh`;
  },
  getObservedMessage(messageId: string): string {
    return `/mail/query/observed-messages/${encodeURIComponent(messageId)}`;
  },
  contact(contactId: string): string {
    return `/mail/contacts/${encodeURIComponent(contactId)}`;
  },
  taxonomyItem(itemId: string): string {
    return `/mail/taxonomy/${encodeURIComponent(itemId)}`;
  },
  taxonomyUpsert(kind: "folder" | "label", key: string): string {
    return `/mail/taxonomy/${encodeURIComponent(kind)}/${encodeURIComponent(key)}`;
  },
} as const;

export interface GetMailCatalogHttpResponse {
  catalog: EasyEmailCatalog;
}

export interface RegisterCloudflareTempEmailRuntimeHttpResponse {
  result: RegisterCloudflareTempEmailRuntimeResult;
}

export interface ApplyMailCredentialSetsHttpRequest {
  providerInstanceId: string;
  credentialSets: CredentialSetDefinition[];
}

export interface ApplyMailCredentialSetsHttpResponse {
  result: {
    instance: ProviderInstance;
    credentialSets: ProviderCredentialSet[];
    credentialBindings: ProviderCredentialBinding[];
  };
}

export interface ProbeProviderInstanceHttpResponse {
  probe: ProviderHealthProbeResult;
}

export interface ProbeAllProviderInstancesHttpResponse {
  probes: ProviderHealthProbeResult[];
}

export interface QueryProviderInstancesHttpResponse {
  instances: ProviderInstance[];
}

export interface QueryHostBindingsHttpResponse {
  bindings: HostBinding[];
}

export interface QueryMailboxSessionsHttpResponse {
  sessions: MailboxSession[];
}

export interface QueryObservedMessagesHttpResponse {
  messages: ObservedMessage[];
}

export interface GetObservedMessageHttpResponse {
  message?: ObservedMessage;
}

export interface GetMailPersistenceStatsHttpResponse {
  stats: MailPersistenceStats;
}

export type ListContactsHttpRequest = ContactListQuery;
export interface ListContactsHttpResponse {
  contacts: Contact[];
  nextCursor?: string;
}

export type CreateContactHttpRequest = ContactCreateInput;
export interface CreateContactHttpResponse {
  contact: Contact;
}

export interface GetContactHttpResponse {
  contact: Contact;
}

export type UpdateContactHttpRequest = ContactUpdateInput;
export interface UpdateContactHttpResponse {
  contact: Contact;
}

export type DeleteContactHttpRequest = ContactDeleteInput;
export interface DeleteContactHttpResponse {
  deleted: { id: string };
}

export type ListMailTaxonomyHttpRequest = MailTaxonomyListQuery;
export interface ListMailTaxonomyHttpResponse {
  items: MailTaxonomyItem[];
  nextCursor?: string;
  capabilities: MailTaxonomyCapabilities;
}

export type UpsertMailTaxonomyHttpRequest = MailTaxonomyUpsertRequest;
export interface UpsertMailTaxonomyHttpResponse {
  item: MailTaxonomyItem;
  capabilities: MailTaxonomyCapabilities;
}

export interface GetMailTaxonomyHttpResponse extends UpsertMailTaxonomyHttpResponse {}

export type UpdateMailTaxonomyHttpRequest = MailTaxonomyUpdateRequest;
export interface UpdateMailTaxonomyHttpResponse extends UpsertMailTaxonomyHttpResponse {}

export type DeleteMailTaxonomyHttpRequest = MailTaxonomyDeleteRequest;
export interface DeleteMailTaxonomyHttpResponse {
  deleted: { id: string; changed: boolean };
  capabilities: MailTaxonomyCapabilities;
}

export type PlanMailboxHttpRequest = VerificationMailboxRequest;
export interface PlanMailboxHttpResponse {
  plan: MailboxPlanResult;
}

export type OpenMailboxHttpRequest = VerificationMailboxRequest;
export interface OpenMailboxHttpResponse {
  result: VerificationMailboxOpenResult;
}

export interface MailboxRefreshFailure {
  sessionId: string;
  errorCode: string;
}

export interface MailboxRefreshResult {
  fetchedCount: number;
  insertedCount: number;
  skippedCount: number;
  failedCount: number;
  refreshedSessionIds: string[];
  skippedSessionIds: string[];
  failures: MailboxRefreshFailure[];
}

export interface RefreshMailboxHttpResponse {
  refresh: MailboxRefreshResult;
}

export interface RefreshAnonymousMailboxesHttpRequest {
  hostId: string;
}

export interface RefreshAnonymousMailboxesHttpResponse {
  refresh: MailboxRefreshResult;
}

export type SendMailboxMessageHttpRequest = MailboxSendRequest;
export interface SendMailboxMessageHttpResponse {
  result: MailboxSendResult;
}

export type UpdateMailboxSessionHttpRequest = MailboxSessionUpdateRequest;
export interface UpdateMailboxSessionHttpResponse {
  session: MailboxSession;
}

export interface ReleaseMailboxHttpRequest {
  sessionId: string;
  reason?: string;
}

export interface ReleaseMailboxHttpResponse {
  result: {
    session: MailboxSession;
    providerInstanceId: string;
    providerTypeKey: MailboxSession["providerTypeKey"];
    released: boolean;
    detail?: string;
  };
}

export interface RecoverMailboxByEmailHttpRequest {
  emailAddress?: string;
  providerTypeKey?: MailProviderTypeKey;
  providerInstanceId?: string;
  hostId?: string;
  recoveryDataCredential?: Record<string, string>;
  recoveryFields?: Record<string, string>;
}

export interface RecoverMailboxByEmailHttpResponse {
  result: {
    recovered: boolean;
    strategy: "account_restore" | "session_restore" | "recreate_same_address" | "not_supported";
    session?: MailboxSession;
    providerTypeKey?: MailProviderTypeKey;
    providerInstanceId?: string;
    detail?: string;
  } & Partial<MailboxAccessDescriptor>;
}

export interface RecoverMailboxCapacityHttpRequest {
  failureCode?: string;
  detail?: string;
  providerTypeKey?: string;
  providerInstanceId?: string;
  staleAfterSeconds?: number;
  maxDeleteCount?: number;
  force?: boolean;
}

export interface RecoverMailboxCapacityHttpResponse {
  result: {
    ok: boolean;
    status: string;
    providerTypeKey?: MailProviderTypeKey;
    providerInstanceId?: string;
    action?: string;
    detail?: string;
    recovery?: unknown;
  };
}

export interface CleanupMoemailMailboxesHttpRequest {
  staleAfterSeconds?: number;
  maxDeleteCount?: number;
  force?: boolean;
  providerInstanceId?: string;
}

export interface CleanupMoemailMailboxesHttpResponse {
  result: {
    providerInstanceId: string;
    staleAfterSeconds: number;
    force: boolean;
    scannedCount: number;
    deletedCount: number;
    skippedCount: number;
    nextCursor?: string;
    deleted: Array<{
      emailId: string;
      email: string;
      detail?: string;
    }>;
    skipped: Array<{
      emailId: string;
      email: string;
      reason: string;
    }>;
  };
}

export type ReportMailboxOutcomeHttpRequest = MailboxOutcomeReport;
export interface ReportMailboxOutcomeHttpResponse {
  result: MailboxOutcomeReportResult;
}

export type ObserveMessageHttpRequest = ObserveMessageInput;
export interface ObserveMessageHttpResponse {
  message: ObservedMessage;
}

export type RegisterCloudflareTempEmailRuntimeHttpRequest = RegisterCloudflareTempEmailRuntimeRequest;

export interface ReadVerificationCodeHttpResponse {
  code?: VerificationCodeResult;
}

export interface ReadAuthenticationLinkHttpResponse {
  authLink?: AuthenticationLinkResult;
}

export interface GetMailSnapshotHttpResponse {
  snapshot: EasyEmailSnapshot;
}

export interface RunMaintenanceHttpResponse {
  maintenance: EasyEmailMaintenanceResult;
}

export type QueryProviderInstancesHttpRequest = ProviderInstanceQueryFilters;
export type QueryHostBindingsHttpRequest = HostBindingQueryFilters;
export type QueryMailboxSessionsHttpRequest = MailboxSessionQueryFilters;
export type QueryObservedMessagesHttpRequest = ObservedMessageQueryFilters;
