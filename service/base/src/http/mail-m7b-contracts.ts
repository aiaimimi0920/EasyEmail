import type { MailAccount } from "../domain/account.js";
import type {
  MailAgentAccountCreateInput,
  MailAgentAccountListQuery,
  MailAgentServiceCreateInput,
  MailAgentServiceRecord,
  MailAgentTaskSendInput,
  MailAgentTaskSendResult,
  MailAgentThread,
  MailAgentThreadDetail,
  MailAgentThreadListQuery,
} from "../domain/mail-agent.js";

export type CreateAgentMailAccountHttpRequest = MailAgentAccountCreateInput;
export interface CreateAgentMailAccountHttpResponse {
  account: MailAccount;
}

export type ListAgentMailAccountsHttpRequest = MailAgentAccountListQuery;
export interface ListAgentMailAccountsHttpResponse {
  accounts: MailAccount[];
  nextCursor?: string;
}

export type CreateAgentMailServiceHttpRequest = MailAgentServiceCreateInput;
export interface CreateAgentMailServiceHttpResponse {
  service: MailAgentServiceRecord;
}

export interface ListAgentMailServicesHttpResponse {
  services: MailAgentServiceRecord[];
}

export type SendAgentMailTaskHttpRequest = MailAgentTaskSendInput;
export type SendAgentMailTaskHttpResponse = MailAgentTaskSendResult;

export type ListAgentMailThreadsHttpRequest = MailAgentThreadListQuery;
export interface ListAgentMailThreadsHttpResponse {
  threads: MailAgentThread[];
}

export interface GetAgentMailThreadDetailHttpResponse {
  detail: MailAgentThreadDetail;
}
