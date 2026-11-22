import type {
  EasyEmailAgentAccountCreateRequest,
  EasyEmailAgentAccountListQuery,
  EasyEmailAgentAccountResponse,
  EasyEmailAgentAccountsResponse,
  EasyEmailAgentMessage,
  EasyEmailAgentService,
  EasyEmailAgentServiceCreateRequest,
  EasyEmailAgentServiceResponse,
  EasyEmailAgentServicesResponse,
  EasyEmailAgentTaskSendRequest,
  EasyEmailAgentTaskSendResponse,
  EasyEmailAgentThread,
  EasyEmailAgentThreadDetailResponse,
  EasyEmailAgentThreadListQuery,
  EasyEmailAgentThreadStatus,
  EasyEmailAgentThreadsResponse,
  EasyEmailAgentTrustLevel,
} from "./easyEmailHttpClient.ts";
import { toAccountDto, type AccountDto } from "./mailAccountClient.ts";

export type AgentServiceDto = {
  id: string;
  display_name: string;
  email_address: string;
  description: string | null;
  service_kind: string;
  trust_level: string;
  default_sender_account_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
};

export type AgentThreadDto = {
  id: string;
  agent_service_id: string;
  sender_account_id: string;
  subject: string;
  status: string;
  last_outgoing_message_id: string | null;
  last_incoming_message_id: string | null;
  correlation_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type AgentMessageDto = {
  id: string;
  thread_id: string;
  message_id: string;
  direction: string;
  semantic_role: string;
  parsed_status: string | null;
  created_at: string;
};

export type AgentThreadDetailDto = {
  thread: AgentThreadDto;
  messages: AgentMessageDto[];
};

export type AgentSendTaskDto = {
  thread: AgentThreadDto;
  agent_message: AgentMessageDto;
  queue_id: string;
  queue_status: string;
};

export type AgentAddAccountRequest = {
  display_name: string;
  email_address: string;
  provider_label?: string | null;
};

export type AgentAddServiceRequest = {
  display_name: string;
  email_address: string;
  description?: string | null;
  service_kind?: string | null;
  trust_level: string;
  default_sender_account_id?: string | null;
};

export type AgentSendTaskRequest = {
  agent_service_id: string;
  sender_account_id: string;
  subject: string;
  body_text: string;
  confirm_restricted: boolean;
  idempotency_key?: string | null;
};

export type AgentThreadListRequest = {
  status?: EasyEmailAgentThreadStatus;
  sender_account_id?: string;
  agent_service_id?: string;
  limit?: number;
};

export type AgentThreadDetailRequest = {
  thread_id: string;
};

export interface AgentMailHttpTransport {
  listAgentMailAccounts(
    query?: EasyEmailAgentAccountListQuery,
  ): Promise<EasyEmailAgentAccountsResponse>;
  createAgentMailAccount(
    request: EasyEmailAgentAccountCreateRequest,
  ): Promise<EasyEmailAgentAccountResponse>;
  listAgentMailServices(): Promise<EasyEmailAgentServicesResponse>;
  createAgentMailService(
    request: EasyEmailAgentServiceCreateRequest,
  ): Promise<EasyEmailAgentServiceResponse>;
  sendAgentMailTask(
    request: EasyEmailAgentTaskSendRequest,
    options?: { idempotencyKey?: string },
  ): Promise<EasyEmailAgentTaskSendResponse>;
  listAgentMailThreads(
    query?: EasyEmailAgentThreadListQuery,
  ): Promise<EasyEmailAgentThreadsResponse>;
  getAgentMailThreadDetail(
    threadId: string,
  ): Promise<EasyEmailAgentThreadDetailResponse>;
}

function toAgentServiceDto(service: EasyEmailAgentService): AgentServiceDto {
  return {
    id: service.id,
    display_name: service.displayName,
    email_address: service.emailAddress,
    description: service.description ?? null,
    service_kind: service.serviceKind,
    trust_level: service.trustLevel,
    default_sender_account_id: service.defaultSenderAccountId ?? null,
    status: service.status,
    created_at: service.createdAt,
    updated_at: service.updatedAt,
  };
}

function toAgentThreadDto(thread: EasyEmailAgentThread): AgentThreadDto {
  return {
    id: thread.id,
    agent_service_id: thread.agentServiceId,
    sender_account_id: thread.senderAccountId,
    subject: thread.subject,
    status: thread.status,
    last_outgoing_message_id: thread.lastOutgoingMessageId ?? null,
    last_incoming_message_id: thread.lastIncomingMessageId ?? null,
    correlation_key: thread.correlationKey,
    created_at: thread.createdAt,
    updated_at: thread.updatedAt,
    completed_at: thread.completedAt ?? null,
  };
}

function toAgentMessageDto(message: EasyEmailAgentMessage): AgentMessageDto {
  return {
    id: message.id,
    thread_id: message.threadId,
    message_id: message.messageId,
    direction: message.direction,
    semantic_role: message.semanticRole,
    parsed_status: message.parsedStatus ?? null,
    created_at: message.createdAt,
  };
}

export function createAgentMailClient(transport: AgentMailHttpTransport) {
  return {
    async listAgentAccounts(): Promise<AccountDto[]> {
      const accounts: AccountDto[] = [];
      let cursor: string | undefined;
      do {
        const page = await transport.listAgentMailAccounts({ limit: 100, cursor });
        accounts.push(...page.accounts.map(toAccountDto));
        cursor = page.nextCursor;
      } while (cursor);
      return accounts;
    },

    async addAgentAccount(request: AgentAddAccountRequest): Promise<AccountDto> {
      const response = await transport.createAgentMailAccount({
        displayName: request.display_name,
        emailAddress: request.email_address,
        providerLabel: request.provider_label ?? null,
      });
      return toAccountDto(response.account);
    },

    async listAgentServices(): Promise<AgentServiceDto[]> {
      const response = await transport.listAgentMailServices();
      return response.services.map(toAgentServiceDto);
    },

    async addAgentService(request: AgentAddServiceRequest): Promise<AgentServiceDto> {
      const response = await transport.createAgentMailService({
        displayName: request.display_name,
        emailAddress: request.email_address,
        description: request.description ?? null,
        serviceKind: request.service_kind ?? "email_agent",
        trustLevel: request.trust_level as EasyEmailAgentTrustLevel,
        defaultSenderAccountId: request.default_sender_account_id ?? null,
      });
      return toAgentServiceDto(response.service);
    },

    async sendAgentTask(request: AgentSendTaskRequest): Promise<AgentSendTaskDto> {
      const idempotencyKey = request.idempotency_key?.trim() || undefined;
      const response = await transport.sendAgentMailTask(
        {
          agentServiceId: request.agent_service_id,
          senderAccountId: request.sender_account_id,
          subject: request.subject,
          bodyText: request.body_text,
          confirmRestricted: request.confirm_restricted,
          idempotencyKey: idempotencyKey ?? null,
        },
        idempotencyKey ? { idempotencyKey } : undefined,
      );
      return {
        thread: toAgentThreadDto(response.thread),
        agent_message: toAgentMessageDto(response.agentMessage),
        queue_id: response.queueItem.id,
        queue_status: response.queueItem.status,
      };
    },

    async listAgentThreads(request: AgentThreadListRequest = {}): Promise<AgentThreadDto[]> {
      const response = await transport.listAgentMailThreads({
        status: request.status,
        senderAccountId: request.sender_account_id,
        agentServiceId: request.agent_service_id,
        limit: request.limit,
      });
      return response.threads.map(toAgentThreadDto);
    },

    async getAgentThreadDetail(request: AgentThreadDetailRequest): Promise<AgentThreadDetailDto> {
      const response = await transport.getAgentMailThreadDetail(request.thread_id);
      return {
        thread: toAgentThreadDto(response.detail.thread),
        messages: response.detail.messages.map(toAgentMessageDto),
      };
    },
  };
}
