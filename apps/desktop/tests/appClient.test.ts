import assert from "node:assert/strict";
import test from "node:test";

import { createAppClient, type AppHealthDto } from "../src/api/appClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

test("gets app health without exposing local storage paths", async () => {
  const health: AppHealthDto = {
    status: "ready",
    anonymous_account_id: "account-anonymous",
    normal_account_count: 2,
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: InvokeCommand = async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ command, args });
    return health as T;
  };

  const result = await createAppClient(invokeCommand).getHealth();

  assert.strictEqual(result, health);
  assert.deepEqual(calls, [{ command: "health_check", args: undefined }]);
  assert.equal("database_path" in result, false);
});
