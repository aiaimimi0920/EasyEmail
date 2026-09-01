import type { InvokeCommand } from "./invokeCommand";

export type EasyEmailSettingsDto = {
  service_url: string | null;
  has_api_token: boolean;
};

export type EasyEmailHealthDto = {
  reachable: boolean;
  provider_count: number;
  auth_status: string;
  capabilities_summary: string;
};

export type EasyEmailSettingsUpdateRequest = {
  service_url: string;
};

export type EasyEmailConnectionTestRequest = {
  service_url: string | null;
  api_token: string | null;
};

export function createSettingsClient(invokeCommand: InvokeCommand) {
  return {
    getEasyEmailSettings(): Promise<EasyEmailSettingsDto> {
      return invokeCommand<EasyEmailSettingsDto>("settings_get_easyemail");
    },
    updateEasyEmailSettings(
      request: EasyEmailSettingsUpdateRequest,
    ): Promise<EasyEmailSettingsDto> {
      return invokeCommand<EasyEmailSettingsDto>("settings_update_easyemail", {
        request,
      });
    },
    testEasyEmailConnection(
      request: EasyEmailConnectionTestRequest,
    ): Promise<EasyEmailHealthDto> {
      return invokeCommand<EasyEmailHealthDto>("settings_test_easyemail", {
        request,
      });
    },
  };
}
