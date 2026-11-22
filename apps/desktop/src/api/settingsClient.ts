import type {
  EasyEmailGetEasyEmailSettingsResponse,
  EasyEmailTestEasyEmailConnectionRequest,
  EasyEmailTestEasyEmailConnectionResponse,
  EasyEmailUpdateEasyEmailSettingsRequest,
  EasyEmailUpdateEasyEmailSettingsResponse,
} from "./easyEmailHttpClient.ts";

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

export interface SettingsHttpTransport {
  getEasyEmailSettings(): Promise<EasyEmailGetEasyEmailSettingsResponse>;
  updateEasyEmailSettings(
    request: EasyEmailUpdateEasyEmailSettingsRequest,
  ): Promise<EasyEmailUpdateEasyEmailSettingsResponse>;
  testEasyEmailConnection(
    request?: EasyEmailTestEasyEmailConnectionRequest,
  ): Promise<EasyEmailTestEasyEmailConnectionResponse>;
}

export function createSettingsClient(transport: SettingsHttpTransport) {
  return {
    async getEasyEmailSettings(): Promise<EasyEmailSettingsDto> {
      const response = await transport.getEasyEmailSettings();
      return {
        service_url: response.settings.serviceUrl,
        has_api_token: response.settings.hasApiToken,
      };
    },
    async updateEasyEmailSettings(
      request: EasyEmailSettingsUpdateRequest,
    ): Promise<EasyEmailSettingsDto> {
      const response = await transport.updateEasyEmailSettings({
        serviceUrl: request.service_url,
      });
      return {
        service_url: response.settings.serviceUrl,
        has_api_token: response.settings.hasApiToken,
      };
    },
    async testEasyEmailConnection(
      request: EasyEmailConnectionTestRequest,
    ): Promise<EasyEmailHealthDto> {
      const response = await transport.testEasyEmailConnection({
        serviceUrl: request.service_url,
        apiToken: request.api_token,
      });
      return {
        reachable: response.health.reachable,
        provider_count: response.health.providerCount,
        auth_status: response.health.authStatus,
        capabilities_summary: response.health.capabilitiesSummary,
      };
    },
  };
}
