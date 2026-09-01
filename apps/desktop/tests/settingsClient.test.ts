import assert from "node:assert/strict";
import test from "node:test";

import {
  createSettingsClient,
  type EasyEmailConnectionTestRequest,
  type EasyEmailHealthDto,
  type EasyEmailSettingsDto,
  type EasyEmailSettingsUpdateRequest,
} from "../src/api/settingsClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

type InvokeCall =
  | { command: string }
  | { command: string; args: Record<string, unknown> };

function createFakeInvoke(responses: ReadonlyMap<string, unknown>) {
  const calls: InvokeCall[] = [];
  const invokeCommand: InvokeCommand = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push(args === undefined ? { command } : { command, args });
    if (!responses.has(command)) {
      throw new Error(`Unexpected command: ${command}`);
    }
    return responses.get(command) as T;
  };

  return { calls, invokeCommand };
}

test("gets EasyEmail settings with settings_get_easyemail and no argument object", async () => {
  const settings: EasyEmailSettingsDto = {
    service_url: "https://easyemail.example.test",
    has_api_token: true,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["settings_get_easyemail", settings]]),
  );

  const result = await createSettingsClient(invokeCommand).getEasyEmailSettings();

  assert.strictEqual(result, settings);
  assert.deepEqual(calls, [{ command: "settings_get_easyemail" }]);
  assert.equal("args" in calls[0], false);
});

test("updates EasyEmail settings with settings_update_easyemail and exactly the wrapped request payload", async () => {
  const request: EasyEmailSettingsUpdateRequest = {
    service_url: "https://updated.easyemail.example.test",
  };
  const settings: EasyEmailSettingsDto = {
    service_url: request.service_url,
    has_api_token: false,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["settings_update_easyemail", settings]]),
  );

  const result = await createSettingsClient(invokeCommand).updateEasyEmailSettings(request);

  assert.strictEqual(result, settings);
  assert.deepEqual(calls, [
    {
      command: "settings_update_easyemail",
      args: { request },
    },
  ]);
  const updateCall = calls[0];
  assert.ok("args" in updateCall);
  assert.strictEqual(updateCall.args.request, request);
});

test("tests the EasyEmail connection with settings_test_easyemail and preserves nullable request values", async () => {
  const request: EasyEmailConnectionTestRequest = {
    service_url: null,
    api_token: null,
  };
  const health: EasyEmailHealthDto = {
    reachable: true,
    provider_count: 3,
    auth_status: "configured",
    capabilities_summary: "temporary mail and verification",
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["settings_test_easyemail", health]]),
  );

  const result = await createSettingsClient(invokeCommand).testEasyEmailConnection(request);

  assert.strictEqual(result, health);
  assert.deepEqual(calls, [
    {
      command: "settings_test_easyemail",
      args: { request },
    },
  ]);
  const testCall = calls[0];
  assert.ok("args" in testCall);
  assert.strictEqual(testCall.args.request, request);
  assert.deepEqual(testCall.args.request, {
    service_url: null,
    api_token: null,
  });
});
