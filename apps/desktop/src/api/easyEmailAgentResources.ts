import type {
  EasyEmailAgentAccountCreateRequest,
  EasyEmailAgentAccountListQuery,
  EasyEmailAgentAccountResponse,
  EasyEmailAgentAccountsResponse,
  EasyEmailAgentServiceCreateRequest,
  EasyEmailAgentServiceResponse,
  EasyEmailAgentServicesResponse,
  EasyEmailAgentTaskSendRequest,
  EasyEmailAgentTaskSendResponse,
  EasyEmailAgentThreadDetailResponse,
  EasyEmailAgentThreadListQuery,
  EasyEmailAgentThreadsResponse,
} from "./easyEmailAgentTypes.ts";
import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailAgentResources(request: EasyEmailRequestTransport) {
  return {
    listAgentMailAccounts(
      query: EasyEmailAgentAccountListQuery = {},
    ): Promise<EasyEmailAgentAccountsResponse> {
      return request<EasyEmailAgentAccountsResponse>({
        path: EASY_EMAIL_CORE_ROUTES.agentAccounts,
        query: {
          limit: query.limit,
          cursor: query.cursor,
        },
      });
    },

    createAgentMailAccount(
      body: EasyEmailAgentAccountCreateRequest,
    ): Promise<EasyEmailAgentAccountResponse> {
      return request<EasyEmailAgentAccountResponse>({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.agentAccounts,
        body,
      });
    },

    listAgentMailServices(): Promise<EasyEmailAgentServicesResponse> {
      return request<EasyEmailAgentServicesResponse>({
        path: EASY_EMAIL_CORE_ROUTES.agentServices,
      });
    },

    createAgentMailService(
      body: EasyEmailAgentServiceCreateRequest,
    ): Promise<EasyEmailAgentServiceResponse> {
      return request<EasyEmailAgentServiceResponse>({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.agentServices,
        body,
      });
    },

    sendAgentMailTask(
      body: EasyEmailAgentTaskSendRequest,
      options: { idempotencyKey?: string } = {},
    ): Promise<EasyEmailAgentTaskSendResponse> {
      const idempotencyKey = options.idempotencyKey?.trim() || body.idempotencyKey?.trim();
      return request<EasyEmailAgentTaskSendResponse>({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.agentTasks,
        headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
        body,
      });
    },

    listAgentMailThreads(
      query: EasyEmailAgentThreadListQuery = {},
    ): Promise<EasyEmailAgentThreadsResponse> {
      return request<EasyEmailAgentThreadsResponse>({
        path: EASY_EMAIL_CORE_ROUTES.agentThreads,
        query: {
          status: query.status,
          senderAccountId: query.senderAccountId,
          agentServiceId: query.agentServiceId,
          limit: query.limit,
        },
      });
    },

    getAgentMailThreadDetail(threadId: string): Promise<EasyEmailAgentThreadDetailResponse> {
      return request<EasyEmailAgentThreadDetailResponse>({
        path: EASY_EMAIL_CORE_ROUTES.agentThread(threadId),
      });
    },
  };
}
