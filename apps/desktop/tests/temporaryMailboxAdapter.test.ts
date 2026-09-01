import assert from "node:assert/strict";
import test from "node:test";

import type {
  EasyEmailObservedMessage,
  EasyEmailVerificationMailboxOpenResult,
} from "../src/api/easyEmailHttpClient.ts";
import {
  temporaryMailboxRecordFromOpenResult,
  temporaryMailboxViewFromSession,
  temporaryObservedMessageView,
  temporaryVerificationCodeView,
} from "../src/mail/temporaryMailboxAdapter.ts";

const openResult: EasyEmailVerificationMailboxOpenResult = {
  session: {
    id: "session-1",
    hostId: "easyemail-desktop",
    providerTypeKey: "cloudflare_temp_email",
    providerInstanceId: "instance-1",
    emailAddress: "code@example.test",
    mailboxRef: "provider-mailbox-1",
    status: "open",
    createdAt: "2026-09-01T01:00:00.000Z",
    expiresAt: "2026-09-01T02:00:00.000Z",
    metadata: { targetService: "github" },
  },
  instance: {
    id: "instance-1",
    providerTypeKey: "cloudflare_temp_email",
    displayName: "Cloudflare Temp Email",
    status: "active",
    runtimeKind: "external",
    connectorKind: "http",
    shared: true,
    costTier: "free",
    healthScore: 100,
    averageLatencyMs: 20,
    connectionRef: "connection-1",
    hostBindings: ["easyemail-desktop"],
    groupKeys: [],
    metadata: {},
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  },
  binding: {
    hostId: "easyemail-desktop",
    providerTypeKey: "cloudflare_temp_email",
    bindingMode: "shared-instance",
    instanceId: "instance-1",
    updatedAt: "2026-09-01T01:00:00.000Z",
  },
  temporaryAuthCredential: {
    credentialType: "bearer",
    fields: { token: "runtime-only-secret" },
    serverManaged: true,
  },
  recoveryDataCredential: { accountId: "recovery-account-1", key: "recovery-secret" },
  recoverabilityLevel: "recoverable",
  recoveryRequiredFields: {
    evidenceStatus: "verified",
    minimumHorizonDays: 30,
    reason: "provider supports recovery",
    fields: { accountId: "required" },
    serverSidePrerequisites: ["provider credential"],
  },
  createdByProvider: {
    providerTypeKey: "cloudflare_temp_email",
    providerInstanceId: "instance-1",
    displayName: "Cloudflare Temp Email",
  },
};

test("keeps the canonical open result while deriving the legacy-shaped display view", () => {
  const record = temporaryMailboxRecordFromOpenResult(openResult);

  assert.strictEqual(record.access, openResult);
  assert.deepEqual(record.access.recoveryDataCredential, {
    accountId: "recovery-account-1",
    key: "recovery-secret",
  });
  assert.equal(record.access.temporaryAuthCredential.fields.token, "runtime-only-secret");
  assert.equal(record.access.recoverabilityLevel, "recoverable");
  assert.equal(record.access.createdByProvider.providerInstanceId, "instance-1");
  assert.deepEqual(record.view, {
    id: "session-1",
    email_address: "code@example.test",
    provider_id: "instance-1",
    provider_label: "Cloudflare Temp Email",
    visibility_state: "anonymous",
    lifecycle_state: "active",
    easyemail_mailbox_id: "session-1",
    lease_expires_at: "2026-09-01T02:00:00.000Z",
    created_at: "2026-09-01T01:00:00.000Z",
    updated_at: "2026-09-01T01:00:00.000Z",
  });
});

test("maps canonical session lifecycle states without inventing provider access data", () => {
  const resolved = temporaryMailboxViewFromSession({
    ...openResult.session,
    status: "resolved",
    expiresAt: undefined,
  });
  const expired = temporaryMailboxViewFromSession({
    ...openResult.session,
    status: "expired",
  });

  assert.equal(resolved.lifecycle_state, "history_only");
  assert.equal(resolved.provider_label, "cloudflare_temp_email");
  assert.equal(resolved.lease_expires_at, null);
  assert.equal(expired.lifecycle_state, "expired");
});

test("derives temporary message and code views from canonical message data", () => {
  const mailbox = temporaryMailboxRecordFromOpenResult(openResult).view;
  const message: EasyEmailObservedMessage = {
    id: "message-1",
    sessionId: "session-1",
    providerInstanceId: "instance-1",
    observedAt: "2026-09-01T01:10:00.000Z",
    sender: "GitHub <noreply@github.com>",
    subject: "Your verification code",
    textBody: "  Use   123456 to continue.  ",
    extractedCode: "123456",
    codeSource: "text",
  };

  const messageView = temporaryObservedMessageView(message, mailbox);
  const codeView = temporaryVerificationCodeView(
    {
      sessionId: "session-1",
      providerInstanceId: "instance-1",
      code: "123456",
      source: "text",
      observedMessageId: "message-1",
      receivedAt: "2026-09-01T01:10:00.000Z",
    },
    mailbox,
    message,
  );

  assert.equal(messageView.snippet, "Use 123456 to continue.");
  assert.equal(messageView.received_address, "code@example.test");
  assert.equal(codeView.code, "123456");
  assert.equal(codeView.message_id, "message-1");
  assert.equal(codeView.subject, "Your verification code");
});
