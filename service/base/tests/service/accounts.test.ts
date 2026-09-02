import { describe, expect, it } from "vitest";

import type {
  MailAccount,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryUpdateInput,
} from "../../src/domain/account.js";
import { MailAccountService } from "../../src/service/accounts.js";
import { EasyEmailError } from "../../src/domain/errors.js";

class MemoryAccountRepository implements MailAccountRepository {
  private readonly items = new Map<string, MailAccount>();

  public async listMailAccounts(query: MailAccountRepositoryListQuery) {
    const values = [...this.items.values()]
      .filter((item) => query.scope === undefined || item.scope === query.scope)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    return { accounts: values.slice(0, query.limit), hasMore: values.length > query.limit };
  }

  public async getMailAccount(id: string) { return this.items.get(id); }

  public async createMailAccount(input: MailAccountRepositoryCreateInput) {
    const account: MailAccount = {
      id: input.id,
      scope: input.scope,
      kind: input.kind,
      displayName: input.displayName,
      primaryAddress: input.primaryAddress,
      providerLabel: input.providerLabel,
      imap: input.imap,
      status: input.status,
      authStatus: input.authStatus,
      receiveStatus: input.receiveStatus,
      sendStatus: input.sendStatus,
      listedInAllAccounts: input.listedInAllAccounts,
      version: 1,
      createdAt: input.now,
      updatedAt: input.now,
      credentialRefs: input.credentialRefs.map((ref, index) => ({
        id: `cred_v1_${index}`,
        ownerAccountId: input.id,
        ...ref,
        status: "missing",
        createdAt: input.now,
        updatedAt: input.now,
      })),
    };
    this.items.set(account.id, account);
    return account;
  }

  public async updateMailAccount(input: MailAccountRepositoryUpdateInput) {
    const current = this.items.get(input.id);
    if (!current || current.version !== input.expectedVersion) return undefined;
    const next: MailAccount = {
      ...current,
      displayName: input.displayName,
      providerLabel: input.providerLabel,
      imap: input.imap,
      listedInAllAccounts: input.listedInAllAccounts,
      version: current.version + 1,
      updatedAt: input.now,
    };
    this.items.set(input.id, next);
    return next;
  }

  public async disableMailAccount(id: string, expectedVersion: number, now: string) {
    const current = this.items.get(id);
    if (!current || current.version !== expectedVersion) return undefined;
    const next = {
      ...current,
      status: "disabled" as const,
      receiveStatus: "disabled" as const,
      sendStatus: "disabled" as const,
      version: current.version + 1,
      updatedAt: now,
    };
    this.items.set(id, next);
    return next;
  }

  public async deleteMailAccount(id: string, expectedVersion: number) {
    const current = this.items.get(id);
    return Boolean(current && current.version === expectedVersion && this.items.delete(id));
  }
}

describe("MailAccountService", () => {
  it("creates only supported account scopes and keeps credential refs opaque", async () => {
    const service = new MailAccountService(new MemoryAccountRepository(), () => new Date("2026-09-02T00:00:00Z"));
    const account = await service.createAccount({
      kind: "normal_long_lived",
      displayName: " Work Mail ",
      primaryAddress: "WORK@Example.COM",
      imap: {
        host: " IMAP.Example.COM ",
        port: 993,
        security: "ssl",
        username: " work@example.com ",
      },
      credentialRefs: [{
        secretBackend: "windows_credential_manager",
        secretKey: "ref:v1:cred/work-imap",
        credentialKind: "imap_password",
        authMethod: "password",
      }],
    });
    expect(account).toMatchObject({
      scope: "normal",
      kind: "normal_long_lived",
      displayName: "Work Mail",
      primaryAddress: "work@example.com",
      imap: {
        protocol: "imap",
        host: "imap.example.com",
        port: 993,
        security: "tls",
        username: "work@example.com",
      },
      status: "configuring",
      authStatus: "missing",
    });
    expect(account.credentialRefs[0]).toMatchObject({
      secretKey: "ref:v1:cred/work-imap",
      status: "missing",
    });
    expect(JSON.stringify(account)).not.toContain("password-value");

    await expect(service.createAccount({
      kind: "normal_long_lived",
      displayName: "Leaked",
      primaryAddress: "leaked@example.com",
      credentialRefs: [{
        secretBackend: "vault",
        secretKey: "ref:v1:cred/leaked",
        credentialKind: "imap_password",
        authMethod: "password",
        secret: "password-value",
      } as never],
    })).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN" });

    await expect(service.createAccount({
      kind: "normal_long_lived",
      displayName: "Top-level leak",
      primaryAddress: "top-level-leak@example.com",
      password: "password-value",
    } as never)).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN" });

    await expect(service.createAccount({
      kind: "normal_long_lived",
      displayName: "Legacy ref",
      primaryAddress: "legacy-ref@example.com",
      credentialRefs: [{
        secretBackend: "vault",
        secretKey: "secret://legacy/account",
        credentialKind: "imap_password",
        authMethod: "password",
      }],
    } as never)).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_INVALID" });

    await expect(service.createAccount({
      kind: "normal_upgraded_temp",
      displayName: "Fabricated promotion",
      primaryAddress: "promoted@example.com",
    } as never)).rejects.toMatchObject({ code: "ACCOUNT_KIND_UNSUPPORTED" });

    await expect(service.createAccount({
      kind: "normal_long_lived",
      displayName: "Unknown field",
      primaryAddress: "unknown-field@example.com",
      unsupported: true,
    } as never)).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });

    await expect(service.createAccount({
      kind: "normal_long_lived",
      displayName: "Null profile",
      primaryAddress: "null-profile@example.com",
      imap: null,
    } as never)).rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
  });

  it("updates and explicitly removes a persisted IMAP profile", async () => {
    const service = new MailAccountService(new MemoryAccountRepository());
    const account = await service.createAccount({
      kind: "normal_long_lived",
      displayName: "Profile",
      primaryAddress: "profile@example.com",
      imap: {
        host: "imap.example.com",
        port: 993,
        security: "tls",
        username: "profile@example.com",
      },
    });
    const updated = await service.updateAccount(account.id, {
      expectedVersion: 1,
      imap: { host: "imap2.example.com", port: 143, security: "starttls", username: "profile" },
    });
    expect(updated).toMatchObject({ version: 2, imap: { host: "imap2.example.com", port: 143 } });
    await expect(service.updateAccount(account.id, { expectedVersion: 2, imap: null }))
      .resolves.toMatchObject({ version: 3, imap: undefined });
  });

  it("enforces CAS for update, disable, and delete", async () => {
    const service = new MailAccountService(new MemoryAccountRepository());
    const account = await service.createAccount({
      kind: "agent_owned",
      scope: "agent",
      displayName: "Agent",
      primaryAddress: "agent@example.com",
    });
    await expect(service.updateAccount(account.id, { expectedVersion: 2, displayName: "Stale" }))
      .rejects.toMatchObject({ code: "ACCOUNT_VERSION_CONFLICT" });
    await expect(service.deleteAccount(account.id, null as never))
      .rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    await expect(service.deleteAccount(account.id, { expectedVersion: 1, password: "password-value" } as never))
      .rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN" });
    await expect(service.deleteAccount(account.id, { expectedVersion: 1, unsupported: true } as never))
      .rejects.toMatchObject({ code: "INVALID_ACCOUNT" });
    const disabled = await service.disableAccount(account.id, 1);
    expect(disabled).toMatchObject({ status: "disabled", version: 2 });
    await expect(service.deleteAccount(account.id, { expectedVersion: 1 }))
      .rejects.toMatchObject({ code: "ACCOUNT_VERSION_CONFLICT" });
    await expect(service.deleteAccount(account.id, { expectedVersion: 2 }))
      .resolves.toEqual({ id: account.id });
  });

  it("resolves only an account-owned IMAP credential and never returns its secret", async () => {
    const canary = "imap-secret-canary";
    const tested: Array<{ host: string; secret: string }> = [];
    const repository = new MemoryAccountRepository();
    const service = new MailAccountService(repository, undefined, {
      credentialResolver: {
        async resolveCredential(request) {
          expect(request.useCase).toBe("imap-test");
          expect(request.credentialRef.ownerAccountId).toBe(request.account.id);
          return { status: "resolved", secret: canary };
        },
      },
      imapTester: {
        async testConnection(profile, secret) {
          tested.push({ host: profile.host, secret });
          return { authenticated: true, capabilitySummary: `IMAP4rev1\n${secret}\tIDLE` };
        },
      },
    });
    const account = await service.createAccount({
      kind: "normal_long_lived",
      displayName: "Connected",
      primaryAddress: "connected@example.com",
      imap: { host: "imap.example.com", port: 993, security: "tls", username: "connected@example.com" },
      credentialRefs: [{
        secretBackend: "fake-vault",
        secretKey: "ref:v1:connected/imap",
        credentialKind: "imap_password",
        authMethod: "password",
      }],
    });
    const result = await service.testImapConnection({
      accountId: account.id,
      credentialRefId: account.credentialRefs[0]!.id,
    });
    expect(result).toEqual({ authenticated: true, capabilitySummary: "IMAP4rev1 [redacted] IDLE" });
    expect(tested).toEqual([{ host: "imap.example.com", secret: canary }]);
    expect(JSON.stringify(result)).not.toContain(canary);

    const other = await service.createAccount({
      kind: "normal_long_lived",
      displayName: "Other",
      primaryAddress: "other-imap@example.com",
      imap: { host: "imap.example.com", port: 993, security: "tls", username: "other@example.com" },
    });
    await expect(service.testImapConnection({
      accountId: other.id,
      credentialRefId: account.credentialRefs[0]!.id,
    })).rejects.toMatchObject({ code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
    await expect(service.testImapConnection({
      accountId: account.id,
      credentialRefId: account.credentialRefs[0]!.id,
      password: canary,
    } as never)).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_REF_SECRET_FORBIDDEN" });
  });

  it("fails closed for missing credentials, unavailable resolvers, and IMAP authentication", async () => {
    const repository = new MemoryAccountRepository();
    const createAccount = async (service: MailAccountService, suffix: string) => service.createAccount({
      kind: "normal_long_lived",
      displayName: suffix,
      primaryAddress: `${suffix}@example.com`,
      imap: { host: "imap.example.com", port: 993, security: "tls", username: `${suffix}@example.com` },
      credentialRefs: [{
        secretBackend: "fake-vault",
        secretKey: `ref:v1:${suffix}/imap`,
        credentialKind: "imap_password",
        authMethod: "password",
      }],
    });

    const unavailable = new MailAccountService(repository);
    const unavailableAccount = await createAccount(unavailable, "unavailable");
    await expect(unavailable.testImapConnection({
      accountId: unavailableAccount.id,
      credentialRefId: unavailableAccount.credentialRefs[0]!.id,
    })).rejects.toMatchObject({ code: "ACCOUNT_CREDENTIAL_UNAVAILABLE" });

    const missing = new MailAccountService(repository, undefined, {
      credentialResolver: { async resolveCredential() { return { status: "missing" }; } },
      imapTester: { async testConnection() { throw new Error("must not run"); } },
    });
    const missingAccount = await createAccount(missing, "missing");
    await expect(missing.testImapConnection({
      accountId: missingAccount.id,
      credentialRefId: missingAccount.credentialRefs[0]!.id,
    })).rejects.toMatchObject({ code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });

    const rejected = new MailAccountService(repository, undefined, {
      credentialResolver: { async resolveCredential() { return { status: "resolved", secret: "bad-canary" }; } },
      imapTester: { async testConnection() { throw new EasyEmailError("IMAP_AUTH_FAILED", "Credentials rejected."); } },
    });
    const rejectedAccount = await createAccount(rejected, "rejected");
    await expect(rejected.testImapConnection({
      accountId: rejectedAccount.id,
      credentialRefId: rejectedAccount.credentialRefs[0]!.id,
    })).rejects.toMatchObject({ code: "IMAP_AUTH_FAILED" });
  });
});
