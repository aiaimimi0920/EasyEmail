import assert from "node:assert/strict";
import test from "node:test";

import {
  createDesktopCoreClient,
  type DesktopCoreRuntimeDto,
} from "../src/api/desktopCoreClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

test("loads the authenticated loopback runtime through the trusted host boundary", async () => {
  const runtime: DesktopCoreRuntimeDto = {
    status: "ready",
    base_url: "http://127.0.0.1:32123",
    api_token: "runtime-only-token",
  };
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const invokeCommand: InvokeCommand = async <T>(command, args) => {
    calls.push({ command, args });
    return runtime as T;
  };

  const result = await createDesktopCoreClient(invokeCommand).getRuntime();

  assert.strictEqual(result, runtime);
  assert.deepEqual(calls, [{ command: "desktop_core_runtime", args: undefined }]);
});
