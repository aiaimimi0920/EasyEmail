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

test("encodes canonical query filters and preserves code/auth-link response keys", async () => {
  const urls: string[] = [];
  const fetchRequest: typeof fetch = async (input) => {
    urls.push(String(input));
    if (urls.length === 1) return jsonResponse({ sessions: [] });
    if (urls.length === 2) return jsonResponse({ messages: [] });
    if (urls.length === 3) return jsonResponse({ code: { code: "123456" } });
    return jsonResponse({ authLink: { url: "https://example.test/login" } });
  };
  const client = createEasyEmailHttpClient({
    baseUrl: "https://mail.example.test/api",
    fetch: fetchRequest,
  });

  assert.deepEqual(
    await client.queryMailboxSessions({ hostId: "desktop/a", status: "open", newestFirst: true }),
    { sessions: [] },
  );
  assert.deepEqual(await client.queryObservedMessages({
    sessionId: "session/a",
    sync: true,
    newestFirst: true,
    limit: 25,
  }), { messages: [] });
  assert.deepEqual(await client.readVerificationCode("session/a"), {
    code: { code: "123456" },
  });
  assert.deepEqual(await client.readAuthenticationLink("session/a"), {
    authLink: { url: "https://example.test/login" },
  });

  assert.equal(
    urls[0],
    "https://mail.example.test/api/mail/query/mailbox-sessions?hostId=desktop%2Fa&status=open&newestFirst=true",
  );
  assert.equal(
    urls[1],
    "https://mail.example.test/api/mail/query/observed-messages?sessionId=session%2Fa&sync=true&newestFirst=true&limit=25",
  );
  assert.equal(
    urls[2],
    "https://mail.example.test/api/mail/mailboxes/session%2Fa/code",
  );
  assert.equal(
    urls[3],
    "https://mail.example.test/api/mail/mailboxes/session%2Fa/auth-link",
  );
});

test("uses explicit HTTP resources for every temporary-mailbox mutation", async () => {
  const calls: CapturedRequest[] = [];
  const fetchRequest: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ result: {}, plan: {}, session: {} });
  };
  const client = createEasyEmailHttpClient({
    baseUrl: "http://localhost:18081",
    fetch: fetchRequest,
  });
  const mailboxRequest = {
    hostId: "easyemail-desktop",
    provisionMode: "auto-create-if-missing" as const,
    bindingMode: "shared-instance" as const,
    metadata: { targetService: "github" },
  };

  await client.planMailbox(mailboxRequest);
  await client.openMailbox(mailboxRequest);
  await client.updateMailbox({ sessionId: "session-1", metadata: { note: "test" } });
  await client.releaseMailbox({ sessionId: "session-1", reason: "user" });
  await client.recoverMailbox({
    emailAddress: "code@example.test",
    recoveryDataCredential: { opaque: "recovery" },
  });
  await client.reportMailboxOutcome({ sessionId: "session-1", success: true });
  await client.sendMailboxMessage({
    sessionId: "session-1",
    toEmailAddress: "target@example.test",
    subject: "hello",
    textBody: "body",
  });
  await client.getObservedMessage("message/a");

  assert.deepEqual(
    calls.map(({ url, init }) => [new URL(url).pathname, init?.method ?? "GET"]),
    [
      ["/mail/mailboxes/plan", "POST"],
      ["/mail/mailboxes/open", "POST"],
      ["/mail/mailboxes/update-session", "POST"],
      ["/mail/mailboxes/release", "POST"],
      ["/mail/mailboxes/recover-by-email", "POST"],
      ["/mail/mailboxes/report-outcome", "POST"],
      ["/mail/mailboxes/send", "POST"],
      ["/mail/query/observed-messages/message%2Fa", "GET"],
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), mailboxRequest);
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), {
    emailAddress: "code@example.test",
    recoveryDataCredential: { opaque: "recovery" },
  });
});

test("queries provider instances used to label canonical mailbox sessions", async () => {
  let capturedUrl = "";
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18081",
    fetch: async (input) => {
      capturedUrl = String(input);
      return jsonResponse({ instances: [{ id: "instance-1" }] });
    },
  });

  assert.deepEqual(await client.queryProviderInstances({ status: "active", shared: true }), {
    instances: [{ id: "instance-1" }],
  });
  assert.equal(
    capturedUrl,
    "http://127.0.0.1:18081/mail/query/provider-instances?status=active&shared=true",
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
