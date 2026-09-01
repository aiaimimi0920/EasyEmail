import assert from "node:assert/strict";
import test from "node:test";

import {
  createPlatformAccountClient,
  type PlatformAccountQueryDto,
  type PlatformAccountQueryRequest,
  type PlatformAccountSessionDto,
} from "../src/api/platformAccountClient.ts";
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

test("gets the complete platform account session with no argument object", async () => {
  const account: PlatformAccountSessionDto["account"] = {
    id: "platform-account-1",
    display_name: "NMail Preview",
    username: "nmail-preview",
    email: "preview@nmail.example.test",
    avatar_initial: "N",
    status: "active",
    plan: "developer-preview",
    home_region: "ap-east-1",
    created_at: "2026-07-25T08:00:00Z",
    updated_at: "2026-07-25T09:00:00Z",
  };
  const usage: PlatformAccountSessionDto["usage"] = {
    account_id: account.id,
    linked_app_count: 3,
    workspace_count: 2,
    api_quota_used: 144,
    api_quota_limit: 1000,
    last_sync_at: "2026-07-25T09:30:00Z",
  };
  const endpoint: PlatformAccountSessionDto["endpoints"][number] = {
    method: "GET",
    path: "/v1/account/session",
    description: "Returns the current platform account session",
  };
  const endpoints = [endpoint];
  const session: PlatformAccountSessionDto = {
    server_kind: "fake-platform-account",
    server_url: "https://platform-account.example.test",
    api_version: "v1",
    auth_mode: "developer-preview",
    account,
    usage,
    endpoints,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["platform_account_get_session", session]]),
  );

  const result = await createPlatformAccountClient(
    invokeCommand,
  ).getPlatformAccountSession();

  assert.strictEqual(result, session);
  assert.strictEqual(result.account, account);
  assert.strictEqual(result.usage, usage);
  assert.strictEqual(result.endpoints, endpoints);
  assert.strictEqual(result.endpoints[0], endpoint);
  assert.deepEqual(calls, [{ command: "platform_account_get_session" }]);
  assert.equal("args" in calls[0], false);
});

test("queries entitlements with exactly one request envelope and preserves unknown payload identity", async () => {
  const request: PlatformAccountQueryRequest = { resource: "entitlements" };
  const payload: unknown = {
    entitlements: ["mail.read", "mail.send"],
    metadata: { source: "fake-platform-account" },
  };
  const queryResult: PlatformAccountQueryDto = {
    resource: "entitlements",
    status: "ok",
    payload,
  };
  const { calls, invokeCommand } = createFakeInvoke(
    new Map<string, unknown>([["platform_account_query_data", queryResult]]),
  );

  const result = await createPlatformAccountClient(
    invokeCommand,
  ).queryPlatformAccountData(request);

  assert.strictEqual(result, queryResult);
  assert.strictEqual(result.payload, payload);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls, [
    {
      command: "platform_account_query_data",
      args: { request },
    },
  ]);
  const queryCall = calls[0];
  assert.ok("args" in queryCall);
  assert.deepEqual(Object.keys(queryCall.args), ["request"]);
  assert.strictEqual(queryCall.args.request, request);
});

test("propagates the exact invoke rejection object unchanged", async () => {
  const rejection = {
    code: "platform_account_unavailable",
    message: "The platform account server is unavailable",
  };
  const invokeCommand: InvokeCommand = <T>(): Promise<T> =>
    Promise.reject<T>(rejection);

  await assert.rejects(
    createPlatformAccountClient(invokeCommand).queryPlatformAccountData({
      resource: "profile",
    }),
    (caught: unknown) => {
      assert.strictEqual(caught, rejection);
      return true;
    },
  );
});
