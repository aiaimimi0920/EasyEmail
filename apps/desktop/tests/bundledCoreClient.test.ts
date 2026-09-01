import assert from "node:assert/strict";
import test from "node:test";

import { createBundledCoreClient } from "../src/api/bundledCoreClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

const HOST_ID = "easyemail-desktop-00000000000000000000000000000001";

test("loads the host runtime once and queries the canonical authenticated catalog", async () => {
  const invokeCalls: string[] = [];
  const httpCalls: Array<{ url: string; authorization: string | null }> = [];
  const invokeCommand: InvokeCommand = async <T>(command) => {
    invokeCalls.push(command);
    return {
      status: "ready",
      base_url: "http://127.0.0.1:32123",
      api_token: "runtime-only-token",
      host_id: HOST_ID,
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

  assert.equal(await client.getHostId(), HOST_ID);
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
      host_id: HOST_ID,
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

test("delegates temporary-mailbox operations through the cached authenticated HTTP client", async () => {
  const invokeCalls: string[] = [];
  const httpCalls: Array<{ path: string; method: string; authorization: string | null }> = [];
  const invokeCommand: InvokeCommand = async <T>(command) => {
    invokeCalls.push(command);
    return {
      status: "ready",
      base_url: "http://127.0.0.1:32123",
      api_token: "runtime-only-token",
      host_id: HOST_ID,
    } as T;
  };
  const fetchRequest: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    httpCalls.push({
      path: `${url.pathname}${url.search}`,
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("authorization"),
    });
    if (url.pathname.endsWith("/open")) return new Response(JSON.stringify({ result: {} }));
    if (url.pathname.endsWith("/refresh")) {
      return new Response(JSON.stringify({
        refresh: {
          fetchedCount: 0,
          insertedCount: 0,
          skippedCount: 0,
          failedCount: 0,
          refreshedSessionIds: [],
          skippedSessionIds: [],
          failures: [],
        },
      }));
    }
    if (url.pathname.endsWith("/mailbox-sessions")) {
      return new Response(JSON.stringify({ sessions: [] }));
    }
    if (url.pathname.endsWith("/observed-messages")) {
      return new Response(JSON.stringify({ messages: [] }));
    }
    return new Response(JSON.stringify({ code: undefined }));
  };
  const client = createBundledCoreClient(invokeCommand, fetchRequest);

  await client.openMailbox({
    hostId: "easyemail-desktop",
    provisionMode: "auto-create-if-missing",
    bindingMode: "shared-instance",
  });
  await client.queryMailboxSessions({ hostId: "easyemail-desktop", newestFirst: true });
  await client.queryObservedMessages({ sessionId: "session-1", sync: true });
  await client.refreshMailbox("session-1");
  await client.refreshAnonymousMailboxes("easyemail-desktop");
  await client.readVerificationCode("session-1");

  assert.deepEqual(invokeCalls, ["desktop_core_runtime"]);
  assert.deepEqual(
    httpCalls.map(({ path, method }) => [path, method]),
    [
      ["/mail/mailboxes/open", "POST"],
      ["/mail/query/mailbox-sessions?hostId=easyemail-desktop&newestFirst=true", "GET"],
      ["/mail/query/observed-messages?sessionId=session-1&sync=true", "GET"],
      ["/mail/mailboxes/session-1/refresh", "POST"],
      ["/mail/mailboxes/anonymous/refresh", "POST"],
      ["/mail/mailboxes/session-1/code", "GET"],
    ],
  );
  assert.ok(httpCalls.every((call) => call.authorization === "Bearer runtime-only-token"));
});
