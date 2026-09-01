import type { InvokeCommand } from "./invokeCommand";

export type PlatformAccountDto = {
  id: string;
  display_name: string;
  username: string;
  email: string;
  avatar_initial: string;
  status: string;
  plan: string;
  home_region: string;
  created_at: string;
  updated_at: string;
};

export type PlatformAccountUsageDto = {
  account_id: string;
  linked_app_count: number;
  workspace_count: number;
  api_quota_used: number;
  api_quota_limit: number;
  last_sync_at: string;
};

export type PlatformAccountEndpointDto = {
  method: string;
  path: string;
  description: string;
};

export type PlatformAccountSessionDto = {
  server_kind: string;
  server_url: string;
  api_version: string;
  auth_mode: string;
  account: PlatformAccountDto;
  usage: PlatformAccountUsageDto;
  endpoints: PlatformAccountEndpointDto[];
};

export type PlatformAccountQueryResource =
  | "session"
  | "profile"
  | "usage"
  | "entitlements";

export type PlatformAccountQueryRequest = {
  resource: PlatformAccountQueryResource;
};

export type PlatformAccountQueryDto = {
  resource: string;
  status: string;
  payload: unknown;
};

export function createPlatformAccountClient(invokeCommand: InvokeCommand) {
  return {
    getPlatformAccountSession(): Promise<PlatformAccountSessionDto> {
      return invokeCommand<PlatformAccountSessionDto>(
        "platform_account_get_session",
      );
    },
    queryPlatformAccountData(
      request: PlatformAccountQueryRequest,
    ): Promise<PlatformAccountQueryDto> {
      return invokeCommand<PlatformAccountQueryDto>(
        "platform_account_query_data",
        { request },
      );
    },
  };
}
