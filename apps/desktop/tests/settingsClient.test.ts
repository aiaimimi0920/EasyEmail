import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettingsClient,
  type EasyEmailConnectionTestRequest,
  type EasyEmailHealthDto,
  type EasyEmailSettingsDto,
  type EasyEmailSettingsUpdateRequest,
  type SettingsHttpTransport,
} from "../src/api/settingsClient.ts";

test("reads EasyEmail settings over HTTP and maps DTO fields", async () => {
  const calls: string[] = [];
  const transport: SettingsHttpTransport = {
    async getEasyEmailSettings() {
      calls.push("getEasyEmailSettings");
      return {
        settings: {
          serviceUrl: "https://easyemail.example.test",
          hasApiToken: true,
        },
      };
    },
    async updateEasyEmailSettings() {
      throw new Error("unexpected");
    },
    async testEasyEmailConnection() {
      throw new Error("unexpected");
    },
  };

  const result: EasyEmailSettingsDto =
    await createSettingsClient(transport).getEasyEmailSettings();

  assert.deepEqual(result, {
    service_url: "https://easyemail.example.test",
    has_api_token: true,
  });
  assert.deepEqual(calls, ["getEasyEmailSettings"]);
});

test("updates EasyEmail settings over HTTP without sending secret fields", async () => {
  const calls: unknown[] = [];
  const transport: SettingsHttpTransport = {
    async getEasyEmailSettings() {
      throw new Error("unexpected");
    },
    async updateEasyEmailSettings(request) {
      calls.push(request);
      return {
        settings: {
          serviceUrl: request.serviceUrl,
          hasApiToken: false,
        },
      };
    },
    async testEasyEmailConnection() {
      throw new Error("unexpected");
    },
  };

  const request: EasyEmailSettingsUpdateRequest = {
    service_url: "https://updated.easyemail.example.test",
  };
  const result = await createSettingsClient(transport).updateEasyEmailSettings(request);

  assert.deepEqual(result, {
    service_url: "https://updated.easyemail.example.test",
    has_api_token: false,
  });
  assert.deepEqual(calls, [{ serviceUrl: "https://updated.easyemail.example.test" }]);
});

test("tests EasyEmail connection over HTTP and preserves nullable request values", async () => {
  const calls: unknown[] = [];
  const transport: SettingsHttpTransport = {
    async getEasyEmailSettings() {
      throw new Error("unexpected");
    },
    async updateEasyEmailSettings() {
      throw new Error("unexpected");
    },
    async testEasyEmailConnection(request) {
      calls.push(request);
      return {
        health: {
          reachable: true,
          providerCount: 3,
          authStatus: "configured",
          capabilitiesSummary: "temporary mail and verification",
        },
      };
    },
  };

  const request: EasyEmailConnectionTestRequest = {
    service_url: null,
    api_token: null,
  };
  const result: EasyEmailHealthDto =
    await createSettingsClient(transport).testEasyEmailConnection(request);

  assert.deepEqual(result, {
    reachable: true,
    provider_count: 3,
    auth_status: "configured",
    capabilities_summary: "temporary mail and verification",
  });
  assert.deepEqual(calls, [{ serviceUrl: null, apiToken: null }]);
});
