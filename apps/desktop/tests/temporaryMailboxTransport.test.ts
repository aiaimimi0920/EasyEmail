import assert from "node:assert/strict";
import test from "node:test";

import { readAppImplementationSource, readDesktopSourceFile } from "./desktopSourceFixture.ts";

test("every migrated temporary-mailbox action uses the bundled HTTP client", async () => {
  const source = readAppImplementationSource();
  const temporaryControllerSource = readDesktopSourceFile(
    "app/useTemporaryMailboxController.tsx",
  );

  for (const command of [
    "temp_create_mailbox",
    "temp_list_mailboxes",
    "temp_refresh_mailbox",
    "temp_refresh_anonymous",
    "verification_poll_temp_mailbox",
  ]) {
    assert.doesNotMatch(source, new RegExp(`invoke[^\\n]*[\"']${command}[\"']`));
  }
  for (const operation of [
    "bundledCoreClient.openMailbox",
    "bundledCoreClient.queryMailboxSessions",
    "bundledCoreClient.queryObservedMessages",
    "bundledCoreClient.refreshMailbox",
    "bundledCoreClient.refreshAnonymousMailboxes",
    "bundledCoreClient.getObservedMessage",
    "bundledCoreClient.readVerificationCode",
    "bundledCoreClient.readAuthenticationLink",
    "bundledCoreClient.recoverMailbox",
    "bundledCoreClient.updateMailbox",
    "bundledCoreClient.reportMailboxOutcome",
    "bundledCoreClient.releaseMailbox",
    "bundledCoreClient.sendMailboxMessage",
  ]) {
    assert.match(source, new RegExp(operation.replace(".", "\\.")));
  }
  assert.match(source, /temporaryMailboxRecordFromOpenResult/);
  assert.match(source, /temporaryMailboxRefreshView/);
  assert.match(source, /MAILBOX_REFRESH_PARTIAL_FAILURE/);
  assert.match(source, /failure\.error_code/);
  assert.doesNotMatch(source, /temporaryMailboxAccessRef|recoveryDataCredential/);
  const refreshStart = temporaryControllerSource.indexOf("async function refreshCoreMailboxes");
  const refreshEnd = temporaryControllerSource.indexOf(
    "async function refreshAnonymousMailOnce",
    refreshStart,
  );
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.doesNotMatch(
    temporaryControllerSource.slice(refreshStart, refreshEnd),
    /queryObservedMessages|sync:\s*true/,
  );
  const temporaryActionsStart = temporaryControllerSource.indexOf("async function createTempMailbox");
  const temporaryActionsEnd = temporaryControllerSource.indexOf("\n  return {", temporaryActionsStart);
  assert.ok(temporaryActionsStart >= 0 && temporaryActionsEnd > temporaryActionsStart);
  assert.doesNotMatch(
    temporaryControllerSource.slice(temporaryActionsStart, temporaryActionsEnd),
    /invoke\s*\(/,
  );
  for (const visibleAction of [
    "Recover from local core",
    "Read auth link",
    "Update sender filter",
    "Report success",
    "Report failure",
    "Send from mailbox",
    "Release mailbox",
  ]) {
    assert.match(source, new RegExp(visibleAction));
  }
});

test("temporary-mailbox HTTP transport never reads the one-shot settings token", async () => {
  const source = readDesktopSourceFile("app/useTemporaryMailboxController.tsx");
  const createStart = source.indexOf("async function createTempMailbox");
  const createEnd = source.indexOf("async function refreshCoreMailboxes", createStart);
  const refreshEnd = source.indexOf("\n  return {", createEnd);

  assert.ok(createStart >= 0 && createEnd > createStart && refreshEnd > createEnd);
  const temporaryFlow = source.slice(createStart, refreshEnd);
  assert.doesNotMatch(temporaryFlow, /apiToken|setApiToken|localStorage|sessionStorage/);
});

test("temporary-mailbox controller wires committed creation to the current source", () => {
  const temporarySource = readDesktopSourceFile("app/useTemporaryMailboxController.tsx");
  const createStart = temporarySource.indexOf("async function createTempMailbox");
  const createEnd = temporarySource.indexOf("async function refreshCoreMailboxes", createStart);
  assert.ok(createStart >= 0 && createEnd > createStart);

  const createFlow = temporarySource.slice(createStart, createEnd);
  assert.match(createFlow, /runTemporaryMailboxCreation\(\{/);
  assert.match(createFlow, /onOpened: \(mailboxRecord\) => \{/);
  assert.match(createFlow, /setTempMailboxes\(\(current\)/);
  assert.match(createFlow, /showStatusToast\(/);
  assert.match(createFlow, /creation\.refreshCompletion\.then/);
  assert.match(createFlow, /return creation\.mailbox\.view\.id;/);

  const mailSource = readDesktopSourceFile("app/useMailSourceController.tsx");
  const sourceActionStart = mailSource.indexOf("async function createAndSelectTempMailbox");
  const sourceActionEnd = mailSource.indexOf("async function syncCurrentMailSource", sourceActionStart);
  assert.ok(sourceActionStart >= 0 && sourceActionEnd > sourceActionStart);
  assert.match(
    mailSource.slice(sourceActionStart, sourceActionEnd),
    /const tempMailboxId = await createTempMailbox\(\);\s*if \(tempMailboxId\) \{\s*selectMailSource\(temporaryMailboxSourceId\(tempMailboxId\)\);/,
  );

  const sourceDrawer = readDesktopSourceFile("components/app/MailSourceDrawer.tsx");
  const setupPanel = readDesktopSourceFile("components/app/EasyEmailSetupPanel.tsx");
  assert.match(sourceDrawer, /onClick=\{createAndSelectTempMailbox\}/);
  assert.match(setupPanel, /onClick=\{createAndSelectTempMailbox\}/);
});

test("temporary-mailbox failures keep actionable auth, timeout, offline, and recovery semantics", async () => {
  const source = readAppImplementationSource();

  for (const errorCode of [
    "request_timeout",
    "core_exited",
    "core_unreachable",
    "TEMP_MAILBOX_RECOVERY_NOT_AVAILABLE",
    "TEMP_MAILBOX_AUTH_LINK_NOT_FOUND",
    "TEMP_MAILBOX_NOT_ACTIVE",
  ]) {
    assert.match(source, new RegExp(errorCode));
  }
  assert.match(source, /credentials are not retained by this UI/);
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setLastAuthenticationLink\(null\);\s*\}, \[selectedTempMailboxId\]\)/,
  );
});
