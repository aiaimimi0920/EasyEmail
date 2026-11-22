import type {
  AuthenticationLinkResult,
  EasyEmailSnapshot,
  HostBindingQueryFilters,
  MailboxAccessDescriptor,
  MailboxOutcomeReport,
  MailboxOutcomeReportResult,
  MailboxPlanResult,
  MailboxSendRequest,
  MailboxSendResult,
  MailboxSession,
  MailboxSessionQueryFilters,
  MailboxSessionUpdateRequest,
  MailProviderTypeKey,
  ObserveMessageInput,
  ObservedMessage,
  ObservedMessageQueryFilters,
  ProviderInstanceQueryFilters,
  RegisterCloudflareTempEmailRuntimeRequest,
  VerificationCodeResult,
  VerificationMailboxOpenResult,
  VerificationMailboxRequest,
} from "../domain/models.js";
import type { EasyEmailMaintenanceResult } from "./contracts.js";

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
