import { describe, expect, it } from "vitest";

import type {
  MailAccount,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryUpdateInput,
} from "../../src/domain/account.js";
import { MailAccountService } from "../../src/service/accounts.js";

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
});
