import assert from "node:assert/strict";
import test from "node:test";

import { createBundledCoreClient } from "../src/api/bundledCoreClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

test("loads the host runtime once and queries the canonical authenticated catalog", async () => {
  const invokeCalls: string[] = [];
  const httpCalls: Array<{ url: string; authorization: string | null }> = [];
  const invokeCommand: InvokeCommand = async <T>(command) => {
    invokeCalls.push(command);
    return {
      status: "ready",
      base_url: "http://127.0.0.1:32123",
      api_token: "runtime-only-token",
    } as T;
  };
  const fetchRequest: typeof fetch = async (input, init) => {
    httpCalls.push({
      url: String(input),
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return new Response(JSON.stringify({ catalog: { providers: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const client = createBundledCoreClient(invokeCommand, fetchRequest);

  const first = await client.getCatalog<{ providers: unknown[] }>();
  const second = await client.getCatalog<{ providers: unknown[] }>();

  assert.deepEqual(first, { catalog: { providers: [] } });
  assert.deepEqual(second, first);
  assert.deepEqual(invokeCalls, ["desktop_core_runtime"]);
  assert.deepEqual(httpCalls, [
    {
      url: "http://127.0.0.1:32123/mail/catalog",
      authorization: "Bearer runtime-only-token",
    },
    {
      url: "http://127.0.0.1:32123/mail/catalog",
      authorization: "Bearer runtime-only-token",
    },
  ]);
});

test("retries runtime discovery after a failed host call", async () => {
  let attempts = 0;
  const invokeCommand: InvokeCommand = async <T>() => {
    attempts += 1;
    if (attempts === 1) throw new Error("core unavailable");
    return {
      status: "ready",
      base_url: "http://127.0.0.1:32123",
      api_token: "runtime-only-token",
    } as T;
  };
  const client = createBundledCoreClient(
    invokeCommand,
    async () => new Response(JSON.stringify({ catalog: {} }), { status: 200 }),
  );

  await assert.rejects(client.getCatalog(), /core unavailable/);
  assert.deepEqual(await client.getCatalog(), { catalog: {} });
  assert.equal(attempts, 2);
});
