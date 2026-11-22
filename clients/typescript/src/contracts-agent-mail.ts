import type {
  MailAccount,
  MailAccountCredentialRefInput,
  MailAccountImapProfileInput,
  MailAccountSmtpProfileInput,
} from "./contracts-catalog.js";
import type { MailSendQueueItem } from "./contracts-send-queue.js";

export type MailAgentTrustLevel = "unknown" | "trusted" | "restricted" | "blocked";
export type MailAgentServiceStatus = "active" | "disabled" | "archived";

export type MailAgentThreadStatus =
  | "draft"
  | "sent"
  | "awaiting_reply"
  | "in_progress"
  | "completed"
  | "failed"
  | "expired"
  | "needs_attention"
  | "archived";

export type MailAgentMessageDirection = "outgoing" | "incoming";

export interface MailAgentAccountCreateInput {
  displayName: string;
  emailAddress: string;
  providerLabel?: string | null;
  imap?: MailAccountImapProfileInput;
  smtp?: MailAccountSmtpProfileInput;
  credentialRefs?: MailAccountCredentialRefInput[];
}

export interface MailAgentAccountListQuery {
  limit?: number;
  cursor?: string;
}

export interface MailAgentAccountListResult {
  accounts: MailAccount[];
  nextCursor?: string;
}

export interface MailAgentServiceRecord {
  id: string;
  displayName: string;
  emailAddress: string;
  description?: string;
  serviceKind: string;
  trustLevel: MailAgentTrustLevel;
  defaultSenderAccountId?: string;
  status: MailAgentServiceStatus;
  createdAt: string;
  updatedAt: string;
}

export interface MailAgentServiceCreateInput {
  displayName: string;
  emailAddress: string;
  description?: string | null;
  serviceKind?: string | null;
  trustLevel: MailAgentTrustLevel;
  defaultSenderAccountId?: string | null;
}

export interface MailAgentThread {
  id: string;
  agentServiceId: string;
  senderAccountId: string;
  subject: string;
  status: MailAgentThreadStatus;
  lastOutgoingMessageId?: string;
  lastIncomingMessageId?: string;
  correlationKey: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface MailAgentThreadListQuery {
  status?: MailAgentThreadStatus;
  senderAccountId?: string;
  agentServiceId?: string;
  limit?: number;
}

export interface MailAgentMessage {
  id: string;
  threadId: string;
  messageId: string;
  direction: MailAgentMessageDirection;
  semanticRole: string;
  parsedStatus?: string;
  createdAt: string;
}

export interface MailAgentThreadDetail {
  thread: MailAgentThread;
  messages: MailAgentMessage[];
}

export interface MailAgentTaskSendInput {
  agentServiceId: string;
  senderAccountId: string;
  subject: string;
  bodyText: string;
  confirmRestricted: boolean;
  idempotencyKey?: string | null;
}

export interface MailAgentTaskSendResult {
  thread: MailAgentThread;
  agentMessage: MailAgentMessage;
  queueItem: MailSendQueueItem;
  deduplicated: boolean;
}
