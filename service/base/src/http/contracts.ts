import type { CredentialSetDefinition } from "../shared/index.js";
import type {
  AuthenticationLinkResult,
  HostBinding,
  HostBindingQueryFilters,
  MailPersistenceStats,
  EasyEmailCatalog,
  EasyEmailSnapshot,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSession,
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
  planMailbox: "/mail/mailboxes/plan",
  openMailbox: "/mail/mailboxes/open",
  sendMailboxMessage: "/mail/mailboxes/send",
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
  getObservedMessage(messageId: string): string {
    return `/mail/query/observed-messages/${encodeURIComponent(messageId)}`;
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

export type PlanMailboxHttpRequest = VerificationMailboxRequest;
export interface PlanMailboxHttpResponse {
  plan: MailboxPlanResult;
}

export type OpenMailboxHttpRequest = VerificationMailboxRequest;
export interface OpenMailboxHttpResponse {
  result: VerificationMailboxOpenResult;
}

export type SendMailboxMessageHttpRequest = MailboxSendRequest;
export interface SendMailboxMessageHttpResponse {
  result: MailboxSendResult;
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
  emailAddress: string;
  providerTypeKey?: MailProviderTypeKey;
  hostId?: string;
}

export interface RecoverMailboxByEmailHttpResponse {
  result: {
    recovered: boolean;
    strategy: "account_restore" | "session_restore" | "recreate_same_address" | "not_supported";
    session?: MailboxSession;
    providerTypeKey?: MailProviderTypeKey;
    providerInstanceId?: string;
    detail?: string;
  };
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
