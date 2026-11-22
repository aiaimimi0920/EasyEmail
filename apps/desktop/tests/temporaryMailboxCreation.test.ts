import assert from "node:assert/strict";
import test from "node:test";

import type { TemporaryMailboxRecord } from "../src/mail/temporaryMailboxAdapter.ts";
import { runTemporaryMailboxCreation } from "../src/app/temporaryMailboxCreation.ts";

function mailboxRecord(): TemporaryMailboxRecord {
  return {
    view: {
      id: "mailbox-created",
      email_address: "created@example.test",
      provider_id: "provider-instance",
      provider_label: "Test Provider",
      visibility_state: "anonymous",
      lifecycle_state: "active",
      easyemail_mailbox_id: "mailbox-created",
      lease_expires_at: null,
      created_at: "2026-09-05T00:00:00Z",
      updated_at: "2026-09-05T00:00:00Z",
    },
    access: {} as TemporaryMailboxRecord["access"],
  };
}

test("commits a created mailbox before starting secondary refreshes", async () => {
  const events: string[] = [];
  const record = mailboxRecord();
  let resolveCoreState!: (value: {
    mailboxes: TemporaryMailboxRecord["view"][];
    messages: [];
    codes: [];
  }) => void;
  let resolveAccounts!: (value: []) => void;
  const result = await runTemporaryMailboxCreation({
    openMailbox: async () => {
      events.push("open");
      return record;
    },
    onOpened: () => events.push("commit"),
    loadCoreTemporaryState: () => new Promise((resolve) => {
      events.push("load-core");
      resolveCoreState = resolve;
    }),
    loadNormalAccounts: () => new Promise((resolve) => {
      events.push("load-accounts");
      resolveAccounts = resolve;
    }),
    onCoreStateLoaded: () => events.push("apply-core"),
    onNormalAccountsLoaded: () => events.push("apply-accounts"),
  });

  assert.equal(result.status, "created");
  assert.deepEqual(events, ["open", "commit", "load-core", "load-accounts"]);
  if (result.status !== "created") return;

  let refreshCompleted = false;
  void result.refreshCompletion.then(() => {
    refreshCompleted = true;
  });
  await Promise.resolve();
  assert.equal(refreshCompleted, false);

  resolveCoreState({ mailboxes: [record.view], messages: [], codes: [] });
  resolveAccounts([]);
  assert.deepEqual(await result.refreshCompletion, { failedRefreshCount: 0 });
  assert.deepEqual(events.slice(4), ["apply-core", "apply-accounts"]);
});

test("keeps creation successful when every secondary refresh fails", async () => {
  const events: string[] = [];
  const record = mailboxRecord();
  const result = await runTemporaryMailboxCreation({
    openMailbox: async () => record,
    onOpened: () => events.push("commit"),
    loadCoreTemporaryState: async () => {
      throw new Error("core list unavailable");
    },
    loadNormalAccounts: async () => {
      throw new Error("account list unavailable");
    },
    onCoreStateLoaded: () => events.push("apply-core"),
    onNormalAccountsLoaded: () => events.push("apply-accounts"),
  });

  assert.equal(result.status, "created");
  if (result.status === "created") {
    assert.equal(result.mailbox, record);
    assert.deepEqual(await result.refreshCompletion, { failedRefreshCount: 2 });
  }
  assert.deepEqual(events, ["commit"]);
});

test("does not commit when opening the mailbox fails", async () => {
  const failure = new Error("provider unavailable");
  let committed = false;
  const result = await runTemporaryMailboxCreation({
    openMailbox: async () => {
      throw failure;
    },
    onOpened: () => {
      committed = true;
    },
    loadCoreTemporaryState: async () => ({ mailboxes: [], messages: [], codes: [] }),
    loadNormalAccounts: async () => [],
    onCoreStateLoaded: () => undefined,
    onNormalAccountsLoaded: () => undefined,
  });

  assert.equal(result.status, "failed");
  if (result.status === "failed") assert.equal(result.error, failure);
  assert.equal(committed, false);
});
