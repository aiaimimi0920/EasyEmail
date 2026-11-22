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

export type PlatformAccountDisabledRejection = {
  code: "platform_dev_session_disabled";
  user_message: string;
  correlation_id: string;
};

export const PLATFORM_DEV_SESSION_DISABLED_ERROR: PlatformAccountDisabledRejection = {
  code: "platform_dev_session_disabled",
  user_message:
    "未签名的平台开发预览会话已永久禁用；真实平台账号登录将作为独立身份能力接入。",
  correlation_id: "platform-dev-session-disabled",
};

export function createPlatformAccountClient() {
  return {
    async getPlatformAccountSession(): Promise<PlatformAccountSessionDto | null> {
      return null;
    },
    async signInPlatformAccount(): Promise<never> {
      throw { ...PLATFORM_DEV_SESSION_DISABLED_ERROR };
    },
    async queryPlatformAccountData(
      _request: PlatformAccountQueryRequest,
    ): Promise<PlatformAccountQueryDto> {
      throw { ...PLATFORM_DEV_SESSION_DISABLED_ERROR };
    },
  };
}
