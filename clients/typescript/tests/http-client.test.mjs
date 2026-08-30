import assert from "node:assert/strict";
import test from "node:test";

import {
  EASY_EMAIL_HTTP_ROUTES,
  EasyEmailClient,
  EasyEmailHttpError,
  EasyEmailTimeoutError,
  createFetchJsonHttpClient,
} from "../dist/index.js";

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("openMailbox sends runtime auth and a JSON request", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "http://127.0.0.1:8080/",
    apiKey: " runtime-key ",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse({ result: { session: { id: "mailbox-1" } } });
    },
  });
  const request = {
    hostId: "registration-worker",
    provisionMode: "reuse-only",
    bindingMode: "shared-instance",
  };

  const result = await client.openMailbox(request);

  assert.equal(result.session.id, "mailbox-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8080/mail/mailboxes/open");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer runtime-key");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(calls[0].init.body), request);
});

test("message routes encode identifiers and query filters", async () => {
  const calls = [];
  const client = new EasyEmailClient({
    baseUrl: "https://mail.example.test",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(url.includes("observed-messages?") ? { messages: [] } : {});
    },
  });

  await client.readVerificationCode("mailbox/a b");
  await client.listObservedMessages({
    sessionId: "mailbox/a b",
    sync: true,
    limit: 25,
  });

  assert.equal(
    calls[0].url,
    "https://mail.example.test/mail/mailboxes/mailbox%2Fa%20b/code",
  );
  const queryUrl = new URL(calls[1].url);
  assert.equal(queryUrl.pathname, EASY_EMAIL_HTTP_ROUTES.queryObservedMessages);
  assert.equal(queryUrl.searchParams.get("sessionId"), "mailbox/a b");
  assert.equal(queryUrl.searchParams.get("sync"), "true");
  assert.equal(queryUrl.searchParams.get("limit"), "25");
});

test("HTTP failures expose status and server error code", async () => {
  const httpClient = createFetchJsonHttpClient({
    baseUrl: "https://mail.example.test",
    fetchImpl: async () => jsonResponse({
      error: "UNAUTHORIZED",
      message: "A valid Bearer token is required.",
    }, 401),
  });

  await assert.rejects(
    () => httpClient.get("/mail/catalog"),
    (error) => {
      assert.ok(error instanceof EasyEmailHttpError);
      assert.equal(error.status, 401);
      assert.equal(error.code, "UNAUTHORIZED");
      assert.equal(error.message, "A valid Bearer token is required.");
      return true;
    },
  );
});

test("timeouts abort the request and expose the timeout budget", async () => {
  const httpClient = createFetchJsonHttpClient({
    baseUrl: "https://mail.example.test",
    timeoutMs: 5,
    fetchImpl: async (_url, init) => await new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    }),
  });

  await assert.rejects(
    () => httpClient.get("/mail/catalog"),
    (error) => {
      assert.ok(error instanceof EasyEmailTimeoutError);
      assert.equal(error.timeoutMs, 5);
      return true;
    },
  );
});

test("invalid transport options fail before making a request", () => {
  assert.throws(
    () => createFetchJsonHttpClient({ baseUrl: "file:///tmp/easy-email" }),
    /must use http or https/,
  );
  assert.throws(
    () => createFetchJsonHttpClient({ baseUrl: "https://mail.example.test", timeoutMs: 0 }),
    /positive finite number/,
  );
});
