import assert from "node:assert/strict";
import test from "node:test";

import {
  EasyEmailHttpError,
  createEasyEmailHttpClient,
  normalizeEasyEmailHttpBaseUrl,
} from "../src/api/easyEmailHttpClient.ts";

type CapturedRequest = {
  url: string;
  init: RequestInit | undefined;
};

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("accepts HTTPS services and loopback HTTP but rejects remote plaintext", () => {
  assert.equal(
    normalizeEasyEmailHttpBaseUrl("http://127.0.0.1:18081/"),
    "http://127.0.0.1:18081",
  );
  assert.equal(
    normalizeEasyEmailHttpBaseUrl("https://mail.example.test/api/"),
    "https://mail.example.test/api",
  );
  assert.throws(
    () => normalizeEasyEmailHttpBaseUrl("http://mail.example.test"),
    /loopback/,
  );
  assert.throws(
    () => normalizeEasyEmailHttpBaseUrl("https://user:secret@mail.example.test"),
    /credentials/,
  );
});

test("sends authenticated canonical mailbox requests without persisting the token", async () => {
  const calls: CapturedRequest[] = [];
  const fetchRequest: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ result: { session: { id: "session-1" } } });
  };
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18081",
    bearerToken: "runtime-only-token",
    fetch: fetchRequest,
  });

  const result = await client.openMailbox({
    hostId: "desktop",
    provisionMode: "auto-create-if-missing",
    bindingMode: "shared-instance",
    providerTypeKey: "cloudflare_temp_email",
  });

  assert.deepEqual(result, { result: { session: { id: "session-1" } } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:18081/mail/mailboxes/open");
  assert.equal(calls[0]?.init?.method, "POST");
  const headers = new Headers(calls[0]?.init?.headers);
  assert.equal(headers.get("authorization"), "Bearer runtime-only-token");
  assert.equal(headers.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    hostId: "desktop",
    provisionMode: "auto-create-if-missing",
    bindingMode: "shared-instance",
    providerTypeKey: "cloudflare_temp_email",
  });
});

test("encodes observed-message filters and dynamic session paths", async () => {
  const urls: string[] = [];
  const fetchRequest: typeof fetch = async (input) => {
    urls.push(String(input));
    return jsonResponse(urls.length === 1 ? { messages: [] } : { result: null });
  };
  const client = createEasyEmailHttpClient({
    baseUrl: "https://mail.example.test/api",
    fetch: fetchRequest,
  });

  await client.queryObservedMessages({
    sessionId: "session/a",
    sync: true,
    newestFirst: true,
    limit: 25,
  });
  await client.readVerificationCode("session/a");

  assert.equal(
    urls[0],
    "https://mail.example.test/api/mail/query/observed-messages?sessionId=session%2Fa&sync=true&newestFirst=true&limit=25",
  );
  assert.equal(
    urls[1],
    "https://mail.example.test/api/mail/mailboxes/session%2Fa/code",
  );
});

test("surfaces structured HTTP failures without including the bearer token", async () => {
  const client = createEasyEmailHttpClient({
    baseUrl: "http://localhost:8080",
    bearerToken: "do-not-leak",
    fetch: async () => jsonResponse({ code: "MAILBOX_MISSING", message: "Mailbox missing." }, 404),
  });

  await assert.rejects(
    client.getCatalog(),
    (error: unknown) => {
      assert.ok(error instanceof EasyEmailHttpError);
      assert.equal(error.status, 404);
      assert.equal(error.message, "Mailbox missing.");
      assert.doesNotMatch(error.message, /do-not-leak/);
      return true;
    },
  );
});
