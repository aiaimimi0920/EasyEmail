import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appSourceUrl = new URL("../src/App.tsx", import.meta.url);

test("temporary mailbox create, list, refresh, message, and code flows use the bundled HTTP client", async () => {
  const source = await readFile(appSourceUrl, "utf8");

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
    "bundledCoreClient.getObservedMessage",
    "bundledCoreClient.readVerificationCode",
  ]) {
    assert.match(source, new RegExp(operation.replace(".", "\\.")));
  }
  assert.match(source, /temporaryMailboxRecordFromOpenResult/);
  assert.doesNotMatch(source, /temporaryMailboxAccessRef|recoveryDataCredential/);
});

test("temporary-mailbox HTTP transport never reads the one-shot settings token", async () => {
  const source = await readFile(appSourceUrl, "utf8");
  const createStart = source.indexOf("async function createTempMailbox");
  const createEnd = source.indexOf("async function refreshCoreMailboxes", createStart);
  const refreshEnd = source.indexOf("const pollWaitingMailboxEvent", createEnd);

  assert.ok(createStart >= 0 && createEnd > createStart && refreshEnd > createEnd);
  const temporaryFlow = source.slice(createStart, refreshEnd);
  assert.doesNotMatch(temporaryFlow, /apiToken|setApiToken|localStorage|sessionStorage/);
});
