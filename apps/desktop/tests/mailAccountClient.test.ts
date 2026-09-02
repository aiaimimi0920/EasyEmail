import assert from "node:assert/strict";
import test from "node:test";

import {
  createMailAccountClient,
  type AccountDto,
  type MailAccountHttpTransport,
  type ManualImapAccountCreateRequest,
} from "../src/api/mailAccountClient.ts";
import type { DesktopCredentialRefDto, DesktopCredentialTransport } from "../src/api/desktopCredentialClient.ts";
import type {
  EasyEmailMailAccount,
  EasyEmailMailAccountResponse,
} from "../src/api/easyEmailHttpClient.ts";

const credentialRef: DesktopCredentialRefDto = {
  secret_backend: "windows_credential_manager",
  secret_key: "ref:v1:desktop/00000000000000000000000000000001",
  credential_kind: "imap_password",
  auth_method: "password",
};

function account(overrides: Partial<EasyEmailMailAccount> = {}): EasyEmailMailAccount {
  return {
    id: "acct_v1_work",
    scope: "normal",
    kind: "normal_long_lived",
    displayName: "Work",
    primaryAddress: "work@example.com",
    providerLabel: "Example",
    imap: { protocol: "imap", host: "imap.example.com", port: 993, security: "tls", username: "work@example.com" },
    status: "ready",
    authStatus: "missing",
    receiveStatus: "enabled",
    sendStatus: "unsupported",
    listedInAllAccounts: true,
    version: 1,
    createdAt: "2026-09-02T00:00:00Z",
    updatedAt: "2026-09-02T00:00:00Z",
    credentialRefs: [{
      id: "cred_v1_work",
      ownerAccountId: "acct_v1_work",
      secretBackend: credentialRef.secret_backend,
      secretKey: credentialRef.secret_key,
      credentialKind: credentialRef.credential_kind,
      authMethod: credentialRef.auth_method,
      status: "missing",
      createdAt: "2026-09-02T00:00:00Z",
      updatedAt: "2026-09-02T00:00:00Z",
    }],
    ...overrides,
  };
}

function createTransport(): MailAccountHttpTransport & { calls: string[]; created?: EasyEmailMailAccountResponse } {
  const calls: string[] = [];
  const created: EasyEmailMailAccountResponse = { account: account() };
  return {
    calls,
    created,
    async listMailAccounts() {
      calls.push("list");
      return { accounts: [account()] };
    },
    async createMailAccount(request) {
      calls.push(`create:${request.credentialRefs?.[0]?.secretKey ?? "none"}`);
      return created;
    },
    async disableMailAccount(accountId, expectedVersion) {
      calls.push(`disable:${accountId}:${expectedVersion}`);
      return { account: account({ status: "disabled", version: expectedVersion + 1 }) };
    },
    async deleteMailAccount(accountId, expectedVersion) {
      calls.push(`delete:${accountId}:${expectedVersion}`);
      return { deleted: { id: accountId } };
    },
    async testMailAccountImap(request) {
      calls.push(`test:${request.accountId}:${request.credentialRefId}`);
      return { result: { authenticated: true, capabilitySummary: "IMAP4rev1 STARTTLS" } };
    },
  };
}

function createCredentials(): DesktopCredentialTransport & { stored: string[]; deleted: string[] } {
  const stored: string[] = [];
  const deleted: string[] = [];
  return {
    stored,
    deleted,
    async storeImapPassword(secret) {
      stored.push(secret);
      return credentialRef;
    },
    async deleteCredential(secretKey) {
      deleted.push(secretKey);
    },
  };
}

test("maps normal account list and IMAP test through the canonical HTTP contract", async () => {
  const transport = createTransport();
  const client = createMailAccountClient(transport, createCredentials());
  assert.deepEqual(await client.listNormalAccounts(), [
    {
      id: "acct_v1_work",
      scope: "normal",
      kind: "normal_long_lived",
      display_name: "Work",
      primary_address: "work@example.com",
      provider_label: "Example",
      status: "ready",
      auth_status: "missing",
      receive_status: "enabled",
      send_status: "unsupported",
      listed_in_all_accounts: true,
      version: 1,
      credential_refs: [{
        id: "cred_v1_work",
        secret_backend: "windows_credential_manager",
        secret_key: credentialRef.secret_key,
        credential_kind: "imap_password",
        auth_method: "password",
        status: "missing",
      }],
    },
  ]);
  const listed = (await client.listNormalAccounts())[0] as AccountDto;
  assert.deepEqual(await client.testImap(listed), {
    authenticated: true,
    capability_summary: "IMAP4rev1 STARTTLS",
  });
  assert.deepEqual(transport.calls, ["list", "list", "test:acct_v1_work:cred_v1_work"]);
});

test("paginates account lists and rejects a repeated cursor", async () => {
  const transport = createTransport();
  const queries: unknown[] = [];
  transport.listMailAccounts = async (query) => {
    queries.push(query);
    if (queries.length === 1) {
      return { accounts: [account()], nextCursor: "page-2" };
    }
    return {
      accounts: [account({ id: "acct_v1_personal", displayName: "Personal" })],
    };
  };
  const client = createMailAccountClient(transport, createCredentials());
  assert.deepEqual((await client.listNormalAccounts()).map((item) => item.id), [
    "acct_v1_work",
    "acct_v1_personal",
  ]);
  assert.deepEqual(queries, [
    { scope: "normal", limit: 100, cursor: undefined },
    { scope: "normal", limit: 100, cursor: "page-2" },
  ]);

  transport.listMailAccounts = async () => ({ accounts: [], nextCursor: "repeated" });
  await assert.rejects(client.listNormalAccounts(), /repeated cursor/);
});

test("stores the password outside HTTP and rolls it back when account creation fails", async () => {
  const transport = createTransport();
  transport.createMailAccount = async () => {
    throw new Error("account create failed");
  };
  const credentials = createCredentials();
  const client = createMailAccountClient(transport, credentials);
  const request: ManualImapAccountCreateRequest = {
    display_name: "Work",
    email_address: "work@example.com",
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_security: "tls",
    imap_username: "work@example.com",
    imap_password: "one-time-password",
  };
  await assert.rejects(client.addManualImapAccount(request), /account create failed/);
  assert.deepEqual(credentials.stored, ["one-time-password"]);
  assert.deepEqual(credentials.deleted, [credentialRef.secret_key]);
});

test("creates an account with only the opaque credential reference over HTTP", async () => {
  const transport = createTransport();
  const credentials = createCredentials();
  const rawSecret = "  password-whitespace-is-significant  ";
  let submittedRequest: unknown;
  transport.createMailAccount = async (request) => {
    submittedRequest = request;
    return { account: account() };
  };
  const client = createMailAccountClient(transport, credentials);

  const result = await client.addManualImapAccount({
    display_name: "Work",
    email_address: "work@example.com",
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_security: "tls",
    imap_username: "work@example.com",
    imap_password: rawSecret,
  });

  assert.equal(result.account.id, "acct_v1_work");
  assert.deepEqual(credentials.stored, [rawSecret]);
  assert.deepEqual(submittedRequest, {
    scope: "normal",
    kind: "normal_long_lived",
    displayName: "Work",
    primaryAddress: "work@example.com",
    imap: {
      host: "imap.example.com",
      port: 993,
      security: "tls",
      username: "work@example.com",
    },
    credentialRefs: [{
      secretBackend: "windows_credential_manager",
      secretKey: credentialRef.secret_key,
      credentialKind: "imap_password",
      authMethod: "password",
    }],
  });
  assert.equal(JSON.stringify(submittedRequest).includes(rawSecret), false);
});

test("rejects an invalid credential reference and removes the stored value", async () => {
  const transport = createTransport();
  const credentials = createCredentials();
  credentials.storeImapPassword = async (secret) => {
    credentials.stored.push(secret);
    return { ...credentialRef, secret_key: "not-an-opaque-reference" };
  };
  const client = createMailAccountClient(transport, credentials);

  await assert.rejects(
    client.addManualImapAccount({
      display_name: "Work",
      email_address: "work@example.com",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_security: "tls",
      imap_username: "work@example.com",
      imap_password: "secret",
    }),
    /invalid opaque reference/,
  );
  assert.deepEqual(transport.calls, []);
  assert.deepEqual(credentials.deleted, ["not-an-opaque-reference"]);
});

test("rolls back the account and credential when create omits the stored ref", async () => {
  const transport = createTransport();
  transport.createMailAccount = async () => ({ account: account({ credentialRefs: [] }) });
  const credentials = createCredentials();
  const client = createMailAccountClient(transport, credentials);

  await assert.rejects(
    client.addManualImapAccount({
      display_name: "Work",
      email_address: "work@example.com",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_security: "tls",
      imap_username: "work@example.com",
      imap_password: "secret",
    }),
    /omitted its stored credential reference/,
  );
  assert.deepEqual(transport.calls, ["delete:acct_v1_work:1"]);
  assert.deepEqual(credentials.deleted, [credentialRef.secret_key]);
});

test("maps disable and delete with CAS versions and cleans desktop refs", async () => {
  const transport = createTransport();
  const credentials = createCredentials();
  const client = createMailAccountClient(transport, credentials);
  const listed = (await client.listNormalAccounts())[0] as AccountDto;
  const disabled = await client.disableAccount(listed);
  assert.equal(disabled.status, "disabled");
  assert.deepEqual(await client.deleteAccount(listed), {
    id: listed.id,
    credential_cleanup_complete: true,
  });
  assert.deepEqual(transport.calls, ["list", "disable:acct_v1_work:1", "delete:acct_v1_work:1"]);
  assert.deepEqual(credentials.deleted, [credentialRef.secret_key]);
});

test("reports partial credential cleanup after an account has been deleted", async () => {
  const transport = createTransport();
  const credentials = createCredentials();
  credentials.deleteCredential = async (secretKey) => {
    credentials.deleted.push(secretKey);
    throw new Error("vault unavailable");
  };
  const client = createMailAccountClient(transport, credentials);
  const listed = (await client.listNormalAccounts())[0] as AccountDto;

  assert.deepEqual(await client.deleteAccount(listed), {
    id: listed.id,
    credential_cleanup_complete: false,
  });
  assert.deepEqual(transport.calls, ["list", "delete:acct_v1_work:1"]);
  assert.deepEqual(credentials.deleted, [credentialRef.secret_key]);
});

test("allows the first IMAP test for a newly stored missing-status reference", async () => {
  const transport = createTransport();
  const client = createMailAccountClient(transport, createCredentials());
  const created = await client.addManualImapAccount({
    display_name: "Work",
    email_address: "work@example.com",
    imap_host: "imap.example.com",
    imap_port: 993,
    imap_security: "tls",
    imap_username: "work@example.com",
    imap_password: "first-test-canary",
  });

  assert.equal(created.account.credential_refs[0]?.status, "missing");
  await assert.doesNotReject(client.testImap(created.account));
  assert.deepEqual(transport.calls, [
    `create:${credentialRef.secret_key}`,
    "test:acct_v1_work:cred_v1_work",
  ]);
});

test("prefers an active IMAP password reference over an older missing reference", async () => {
  const transport = createTransport();
  transport.listMailAccounts = async () => ({
    accounts: [account({
      credentialRefs: [
        ...account().credentialRefs,
        {
          ...account().credentialRefs[0]!,
          id: "cred_v1_active",
          secretKey: "ref:v1:desktop/00000000000000000000000000000002",
          status: "active",
        },
      ],
    })],
  });
  const client = createMailAccountClient(transport, createCredentials());
  const listed = (await client.listNormalAccounts())[0] as AccountDto;

  await assert.doesNotReject(client.testImap(listed));
  assert.deepEqual(transport.calls, ["test:acct_v1_work:cred_v1_active"]);
});

test("refuses IMAP tests for invalid or disabled password references", async () => {
  for (const status of ["invalid", "disabled"] as const) {
    const transport = createTransport();
    transport.listMailAccounts = async () => ({
      accounts: [account({
        credentialRefs: account().credentialRefs.map((credential) => ({
          ...credential,
          status,
        })),
      })],
    });
    const client = createMailAccountClient(transport, createCredentials());
    const listed = (await client.listNormalAccounts())[0] as AccountDto;

    await assert.rejects(client.testImap(listed), /no testable IMAP password reference/);
    assert.deepEqual(transport.calls, []);
  }
});
