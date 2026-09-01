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
  await client.refreshMailbox("session/a");
  await client.refreshAnonymousMailboxes({ hostId: "easyemail-desktop" });
  await client.updateMailbox({ sessionId: "session-1", metadata: { note: "test" } });
  await client.releaseMailbox({ sessionId: "session-1", reason: "user" });
  await client.recoverMailbox({
    emailAddress: "code@example.test",
    recoveryDataCredential: { opaque: "recovery" },
  });
  await client.reportMailboxOutcome({
    sessionId: "session-1",
    success: false,
    failureReason: "provider rejected",
    attribution: {
      strength: "weak",
      kind: "provider_route",
      providerTypeKey: "mailtm",
    },
    policy: { avoidInCurrentAttempt: true, cooldownSeconds: 60 },
  });
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
      ["/mail/mailboxes/session%2Fa/refresh", "POST"],
      ["/mail/mailboxes/anonymous/refresh", "POST"],
      ["/mail/mailboxes/update-session", "POST"],
      ["/mail/mailboxes/release", "POST"],
      ["/mail/mailboxes/recover-by-email", "POST"],
      ["/mail/mailboxes/report-outcome", "POST"],
      ["/mail/mailboxes/send", "POST"],
      ["/mail/query/observed-messages/message%2Fa", "GET"],
    ],
  );
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), mailboxRequest);
  assert.equal(calls[2]?.init?.body, undefined);
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    hostId: "easyemail-desktop",
  });
  assert.deepEqual(JSON.parse(String(calls[6]?.init?.body)), {
    emailAddress: "code@example.test",
    recoveryDataCredential: { opaque: "recovery" },
  });
  assert.deepEqual(JSON.parse(String(calls[7]?.init?.body)), {
    sessionId: "session-1",
    success: false,
    failureReason: "provider rejected",
    attribution: {
      strength: "weak",
      kind: "provider_route",
      providerTypeKey: "mailtm",
    },
    policy: { avoidInCurrentAttempt: true, cooldownSeconds: 60 },
  });
  assert.deepEqual(JSON.parse(String(calls[8]?.init?.body)), {
    sessionId: "session-1",
    toEmailAddress: "target@example.test",
    subject: "hello",
    textBody: "body",
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

test("uses authenticated canonical contact resources", async () => {
  const calls: CapturedRequest[] = [];
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18081",
    bearerToken: "runtime-contact-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      return calls.length === 1
        ? jsonResponse({ contacts: [] })
        : calls.length < 5
          ? jsonResponse({ contact: { id: "contact-1" } })
          : jsonResponse({ deleted: { id: "contact-1" } });
    },
  });

  await client.listContacts({ limit: 25, cursor: "opaque/cursor" });
  await client.createContact({
    displayName: "Ada",
    emailAddress: "ada@example.com",
    note: null,
  });
  await client.getContact("contact/a");
  await client.updateContact("contact/a", { expectedVersion: 1, displayName: "Ada Byron" });
  await client.deleteContact("contact/a", 2);

  assert.equal(
    calls[0]?.url,
    "http://127.0.0.1:18081/mail/contacts?limit=25&cursor=opaque%2Fcursor",
  );
  assert.equal(calls[0]?.init?.method, "GET");
  assert.equal(
    new Headers(calls[0]?.init?.headers).get("authorization"),
    "Bearer runtime-contact-token",
  );
  assert.equal(calls[1]?.url, "http://127.0.0.1:18081/mail/contacts");
  assert.equal(calls[1]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    displayName: "Ada",
    emailAddress: "ada@example.com",
    note: null,
  });
  assert.equal(calls[2]?.url, "http://127.0.0.1:18081/mail/contacts/contact%2Fa");
  assert.equal(calls[2]?.init?.method, "GET");
  assert.equal(calls[3]?.init?.method, "PATCH");
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), {
    expectedVersion: 1,
    displayName: "Ada Byron",
  });
  assert.equal(
    calls[4]?.url,
    "http://127.0.0.1:18081/mail/contacts/contact%2Fa?expectedVersion=2",
  );
  assert.equal(calls[4]?.init?.method, "DELETE");
});

test("uses canonical mail taxonomy resources and preserves capability metadata", async () => {
  const calls: CapturedRequest[] = [];
  const capabilities = { messageReferencePropagation: false };
  const item = {
    id: "mailtax_folder_team/a",
    kind: "folder" as const,
    name: "Team / Alpha",
    color: "#8b5cf6",
    sortOrder: 10,
    system: false,
    version: 1,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  };
  const client = createEasyEmailHttpClient({
    baseUrl: "http://127.0.0.1:18081",
    bearerToken: "runtime-taxonomy-token",
    fetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (init?.method === "DELETE") {
        return jsonResponse({ deleted: { id: item.id, changed: true }, capabilities });
      }
      if (String(input).includes("?")) return jsonResponse({ items: [item], capabilities });
      return jsonResponse({ item, capabilities });
    },
  });

  assert.deepEqual(
    (await client.listMailTaxonomy({ kind: "folder", limit: 10 })).capabilities,
    capabilities,
  );
  await client.getMailTaxonomy(item.id);
  await client.upsertMailTaxonomy("folder", "team___alpha", { name: "Team / Alpha" });
  await client.updateMailTaxonomy(item.id, { expectedVersion: 1, name: "Team Alpha" });
  await client.deleteMailTaxonomy(item.id, 2);

  assert.deepEqual(
    calls.map(({ url, init }) => [new URL(url).pathname, init?.method ?? "GET"]),
    [
      ["/mail/taxonomy", "GET"],
      ["/mail/taxonomy/mailtax_folder_team%2Fa", "GET"],
      ["/mail/taxonomy/folder/team___alpha", "PUT"],
      ["/mail/taxonomy/mailtax_folder_team%2Fa", "PATCH"],
      ["/mail/taxonomy/mailtax_folder_team%2Fa", "DELETE"],
    ],
  );
  assert.equal(
    calls[4]?.url,
    "http://127.0.0.1:18081/mail/taxonomy/mailtax_folder_team%2Fa?expectedVersion=2",
  );
  assert.ok(calls.every(({ init }) => (
    new Headers(init?.headers).get("authorization") === "Bearer runtime-taxonomy-token"
  )));
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
