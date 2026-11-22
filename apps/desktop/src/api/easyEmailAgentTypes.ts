import type {
  EasyEmailMailAccount,
  EasyEmailMailAccountImapProfileInput,
  EasyEmailMailAccountSmtpProfileInput,
} from "./easyEmailMailTypes.ts";
import type { EasyEmailMailSendQueueItem } from "./easyEmailSendQueueTypes.ts";

export interface EasyEmailAgentCredentialRefInput {
  secretBackend: string;
  secretKey: `ref:v1:${string}`;
  credentialKind: string;
  authMethod: string;
}

export type EasyEmailAgentTrustLevel = "unknown" | "trusted" | "restricted" | "blocked";
export type EasyEmailAgentServiceStatus = "active" | "disabled" | "archived";

export type EasyEmailAgentThreadStatus =
  | "draft"
  | "sent"
  | "awaiting_reply"
  | "in_progress"
  | "completed"
  | "failed"
  | "expired"
  | "needs_attention"
  | "archived";

export type EasyEmailAgentMessageDirection = "outgoing" | "incoming";

export interface EasyEmailAgentAccountCreateRequest {
  displayName: string;
  emailAddress: string;
  providerLabel?: string | null;
  imap?: EasyEmailMailAccountImapProfileInput;
  smtp?: EasyEmailMailAccountSmtpProfileInput;
  credentialRefs?: EasyEmailAgentCredentialRefInput[];
}

export interface EasyEmailAgentAccountListQuery {
  limit?: number;
  cursor?: string;
}

export interface EasyEmailAgentAccountsResponse {
  accounts: EasyEmailMailAccount[];
  nextCursor?: string;
}

export interface EasyEmailAgentAccountResponse {
  account: EasyEmailMailAccount;
}

export interface EasyEmailAgentService {
  id: string;
  displayName: string;
  emailAddress: string;
  description?: string;
  serviceKind: string;
  trustLevel: EasyEmailAgentTrustLevel;
  defaultSenderAccountId?: string;
  status: EasyEmailAgentServiceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface EasyEmailAgentServiceCreateRequest {
  displayName: string;
  emailAddress: string;
  description?: string | null;
  serviceKind?: string | null;
  trustLevel: EasyEmailAgentTrustLevel;
  defaultSenderAccountId?: string | null;
}

export interface EasyEmailAgentServiceResponse {
  service: EasyEmailAgentService;
}

export interface EasyEmailAgentServicesResponse {
  services: EasyEmailAgentService[];
}

export interface EasyEmailAgentThread {
  id: string;
  agentServiceId: string;
  senderAccountId: string;
  subject: string;
  status: EasyEmailAgentThreadStatus;
  lastOutgoingMessageId?: string;
  lastIncomingMessageId?: string;
  correlationKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface EasyEmailAgentThreadListQuery {
  status?: EasyEmailAgentThreadStatus;
  senderAccountId?: string;
  agentServiceId?: string;
  limit?: number;
}

export interface EasyEmailAgentThreadsResponse {
  threads: EasyEmailAgentThread[];
}

export interface EasyEmailAgentMessage {
  id: string;
  threadId: string;
  messageId: string;
  direction: EasyEmailAgentMessageDirection;
  semanticRole: string;
  parsedStatus?: string;
  createdAt: string;
}

export interface EasyEmailAgentThreadDetail {
  thread: EasyEmailAgentThread;
  messages: EasyEmailAgentMessage[];
}

export interface EasyEmailAgentThreadDetailResponse {
  detail: EasyEmailAgentThreadDetail;
}

export interface EasyEmailAgentTaskSendRequest {
  agentServiceId: string;
  senderAccountId: string;
  subject: string;
  bodyText: string;
  confirmRestricted: boolean;
  idempotencyKey?: string | null;
}

export interface EasyEmailAgentTaskSendResponse {
  thread: EasyEmailAgentThread;
  agentMessage: EasyEmailAgentMessage;
  queueItem: EasyEmailMailSendQueueItem;
  deduplicated: boolean;
}
