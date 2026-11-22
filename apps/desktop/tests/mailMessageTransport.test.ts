import assert from "node:assert/strict";
import test from "node:test";

import { readAppImplementationSource } from "./desktopSourceFixture.ts";

const MIGRATED_M4_TAURI_COMMANDS = [
  "message_save_local_draft",
  "message_delete_local_draft",
  "message_list",
  "message_get_detail",
  "message_delete_local",
  "message_delete_forever",
  "message_empty_trash",
  "message_set_local_flag",
  "message_set_local_folder",
  "message_set_local_label",
  "verification_list_recent",
  "verification_reclassify_message",
  "verification_poll_temp_mailbox",
] as const;

test("every M4 message, local draft, trash, and verification UI operation uses mailMessageClient over HTTP", () => {
  const source = readAppImplementationSource();

  for (const command of MIGRATED_M4_TAURI_COMMANDS) {
    assert.doesNotMatch(
      source,
      new RegExp(`invoke[^\\n]*[\"']${command}[\"']`),
      `Legacy Tauri command ${command} must not be invoked by React controllers`,
    );
  }

  assert.doesNotMatch(
    source,
    /canonical draft persistence becomes available in M4/,
    "M3 canonical draft placeholder must be removed now that M4 draft persistence is active",
  );

  for (const operation of [
    "mailMessageClient.listAnonymousMessages",
    "mailMessageClient.listNormalAccountMessages",
    "mailMessageClient.listPromotedAccountMessages",
    "mailMessageClient.getMessageDetail",
    "mailMessageClient.saveLocalDraft",
    "mailMessageClient.deleteLocalDraft",
    "mailMessageClient.deleteMessageLocal",
    "mailMessageClient.deleteMessageForever",
    "mailMessageClient.emptyTrash",
    "mailMessageClient.setMessageLocalFlag",
    "mailMessageClient.setMessageLocalFolder",
    "mailMessageClient.setMessageLocalLabel",
    "mailMessageClient.listRecentVerifications",
    "mailMessageClient.reclassifyMessageVerification",
    "mailMessageClient.pollTempMailboxVerification",
  ]) {
    assert.match(source, new RegExp(operation.replace(".", "\\.")));
  }
});
