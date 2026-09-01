import assert from "node:assert/strict";
import test from "node:test";

import {
  createAvatarSettingsClient,
  type AvatarClearCacheDto,
  type AvatarClearCacheRequest,
  type AvatarSettingsDto,
  type AvatarSettingsUpdateRequest,
} from "../src/api/avatarSettingsClient.ts";
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

test("gets avatar settings with avatar_get_settings and no argument object", async () => {
  const settings: AvatarSettingsDto = {
    remote_enabled: true,
    bimi_enabled: false,
    favicon_enabled: true,
    auth_enabled: false,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["avatar_get_settings", settings]]),
  );

  const result = await createAvatarSettingsClient(invokeCommand).getAvatarSettings();

  assert.strictEqual(result, settings);
  assert.deepEqual(calls, [{ command: "avatar_get_settings" }]);
  assert.equal("args" in calls[0], false);
});

test("updates avatar settings with exactly one wrapped request payload", async () => {
  const request: AvatarSettingsUpdateRequest = {
    remote_enabled: false,
    bimi_enabled: true,
    favicon_enabled: false,
    auth_enabled: true,
  };
  const settings: AvatarSettingsDto = { ...request };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["avatar_update_settings", settings]]),
  );

  const result = await createAvatarSettingsClient(invokeCommand).updateAvatarSettings(request);

  assert.strictEqual(result, settings);
  assert.deepEqual(calls, [
    {
      command: "avatar_update_settings",
      args: { request },
    },
  ]);
  const updateCall = calls[0];
  assert.ok("args" in updateCall);
  assert.strictEqual(updateCall.args.request, request);
});

test("clears only the remote avatar cache while preserving include_contacts false", async () => {
  const request: AvatarClearCacheRequest = { include_contacts: false };
  const cleared: AvatarClearCacheDto = { deleted_count: 7 };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["avatar_clear_cache", cleared]]),
  );

  const result = await createAvatarSettingsClient(invokeCommand).clearAvatarCache(request);

  assert.strictEqual(result, cleared);
  assert.deepEqual(calls, [
    {
      command: "avatar_clear_cache",
      args: { request },
    },
  ]);
  const clearCall = calls[0];
  assert.ok("args" in clearCall);
  assert.strictEqual(clearCall.args.request, request);
  assert.deepEqual(clearCall.args.request, { include_contacts: false });
});

test("propagates the exact invoke rejection object unchanged", async () => {
  const rejection = { code: "avatar_settings_failed" };
  const invokeCommand: InvokeCommand = async () => {
    throw rejection;
  };

  await assert.rejects(
    createAvatarSettingsClient(invokeCommand).clearAvatarCache({
      include_contacts: true,
    }),
    (caught: unknown) => caught === rejection,
  );
});
