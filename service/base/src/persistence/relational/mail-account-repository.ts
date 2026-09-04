import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

import type {
  MailAccount,
  MailAccountRepository,
  MailAccountRepositoryCreateInput,
  MailAccountRepositoryListQuery,
  MailAccountRepositoryListResult,
  MailAccountRepositoryUpdateInput,
  MailCredentialRef,
} from "../../domain/account.js";

interface MailAccountSqlRow {
  id: string;
  scope: MailAccount["scope"];
  kind: MailAccount["kind"];
  display_name: string;
  primary_address: string | null;
  provider_label: string | null;
  imap_host: string | null;
  imap_port: number | null;
  imap_security: "tls" | "starttls" | null;
  imap_username: string | null;
  status: MailAccount["status"];
  auth_status: MailAccount["authStatus"];
  receive_status: MailAccount["receiveStatus"];
  send_status: MailAccount["sendStatus"];
  listed_in_all_accounts: number;
  version: number;
  created_at: string;
  updated_at: string;
}

interface MailCredentialRefSqlRow {
  id: string;
  owner_account_id: string;
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
  status: MailCredentialRef["status"];
  created_at: string;
  updated_at: string;
  last_verified_at: string | null;
}

function mapMailCredentialRef(row: MailCredentialRefSqlRow): MailCredentialRef {
  return {
    id: row.id,
    ownerAccountId: row.owner_account_id,
    secretBackend: row.secret_backend,
    secretKey: row.secret_key,
    credentialKind: row.credential_kind,
    authMethod: row.auth_method,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastVerifiedAt: row.last_verified_at ?? undefined,
  };
}

function mapMailAccount(row: MailAccountSqlRow, credentialRefs: MailCredentialRef[]): MailAccount {
  return {
    id: row.id,
    scope: row.scope,
    kind: row.kind,
    displayName: row.display_name,
    primaryAddress: row.primary_address ?? undefined,
    providerLabel: row.provider_label ?? undefined,
    imap: row.imap_host && row.imap_port && row.imap_security && row.imap_username
      ? {
          protocol: "imap",
          host: row.imap_host,
          port: row.imap_port,
          security: row.imap_security,
          username: row.imap_username,
        }
      : undefined,
    status: row.status,
    authStatus: row.auth_status,
    receiveStatus: row.receive_status,
    sendStatus: row.send_status,
    listedInAllAccounts: row.listed_in_all_accounts === 1,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    credentialRefs,
  };
}

export class SqliteMailAccountRepository implements MailAccountRepository {
  public constructor(private readonly database: DatabaseSync) {}

  private async listMailCredentialRefs(accountId: string): Promise<MailCredentialRef[]> {
    const rows = this.database.prepare(`
      SELECT id, owner_account_id, secret_backend, secret_key, credential_kind,
             auth_method, status, created_at, updated_at, last_verified_at
      FROM mail_account_credential_refs
      WHERE owner_account_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(accountId) as unknown as MailCredentialRefSqlRow[];
    return rows.map(mapMailCredentialRef);
  }

  private async mapMailAccountRow(row: MailAccountSqlRow): Promise<MailAccount> {
    return mapMailAccount(row, await this.listMailCredentialRefs(row.id));
  }

  public async listMailAccounts(
    query: MailAccountRepositoryListQuery,
  ): Promise<MailAccountRepositoryListResult> {
    const params: Array<string | number> = [];
    const conditions = ["deleted_at IS NULL"];
    if (query.scope) {
      if (query.scope === "normal") {
        conditions.push("listed_in_all_accounts = 1 AND (scope = 'normal' OR kind = 'anonymous_virtual')");
      } else {
        conditions.push("scope = ?");
        params.push(query.scope);
      }
    }
    if (query.after) {
      conditions.push("(created_at > ? OR (created_at = ? AND id > ?))");
      params.push(query.after.createdAt, query.after.createdAt, query.after.id);
    }
    params.push(query.limit + 1);
    const rows = this.database.prepare(`
      SELECT id, scope, kind, display_name, primary_address, provider_label,
             imap_host, imap_port, imap_security, imap_username,
             status, auth_status, receive_status, send_status,
             listed_in_all_accounts, version, created_at, updated_at
      FROM mail_accounts
      WHERE ${conditions.join(" AND ")}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params) as unknown as MailAccountSqlRow[];
    const accounts = [];
    for (const row of rows.slice(0, query.limit)) {
      accounts.push(await this.mapMailAccountRow(row));
    }
    return {
      accounts,
      hasMore: rows.length > query.limit,
    };
  }

  public async getMailAccount(id: string): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      SELECT id, scope, kind, display_name, primary_address, provider_label,
             imap_host, imap_port, imap_security, imap_username,
             status, auth_status, receive_status, send_status,
             listed_in_all_accounts, version, created_at, updated_at
      FROM mail_accounts
      WHERE id = ? AND deleted_at IS NULL
    `).get(id) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async createMailAccount(input: MailAccountRepositoryCreateInput): Promise<MailAccount> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO mail_accounts (
          id, scope, kind, display_name, primary_address, provider_label,
          imap_host, imap_port, imap_security, imap_username,
          status, auth_status, receive_status, send_status,
          listed_in_all_accounts, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        input.id,
        input.scope,
        input.kind,
        input.displayName,
        input.primaryAddress ?? null,
        input.providerLabel ?? null,
        input.imap?.host ?? null,
        input.imap?.port ?? null,
        input.imap?.security ?? null,
        input.imap?.username ?? null,
        input.status,
        input.authStatus,
        input.receiveStatus,
        input.sendStatus,
        input.listedInAllAccounts ? 1 : 0,
        input.now,
        input.now,
      );
      for (const ref of input.credentialRefs) {
        this.database.prepare(`
          INSERT INTO mail_account_credential_refs (
            id, owner_account_id, secret_backend, secret_key, credential_kind,
            auth_method, status, created_at, updated_at, last_verified_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'missing', ?, ?, NULL)
        `).run(
          `cred_v1_${randomUUID()}`,
          input.id,
          ref.secretBackend,
          ref.secretKey,
          ref.credentialKind,
          ref.authMethod,
          input.now,
          input.now,
        );
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    const account = await this.getMailAccount(input.id);
    if (!account) throw new Error("Mail account create did not return a row.");
    return account;
  }

  public async updateMailAccount(
    input: MailAccountRepositoryUpdateInput,
  ): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_accounts
      SET display_name = ?, provider_label = ?,
          imap_host = ?, imap_port = ?, imap_security = ?, imap_username = ?,
          listed_in_all_accounts = ?,
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
      RETURNING id, scope, kind, display_name, primary_address, provider_label,
                imap_host, imap_port, imap_security, imap_username,
                status, auth_status, receive_status, send_status,
                listed_in_all_accounts, version, created_at, updated_at
    `).get(
      input.displayName,
      input.providerLabel ?? null,
      input.imap?.host ?? null,
      input.imap?.port ?? null,
      input.imap?.security ?? null,
      input.imap?.username ?? null,
      input.listedInAllAccounts ? 1 : 0,
      input.now,
      input.id,
      input.expectedVersion,
    ) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async disableMailAccount(
    id: string,
    expectedVersion: number,
    now: string,
  ): Promise<MailAccount | undefined> {
    const row = this.database.prepare(`
      UPDATE mail_accounts
      SET status = 'disabled', receive_status = 'disabled', send_status = 'disabled',
          version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
      RETURNING id, scope, kind, display_name, primary_address, provider_label,
                imap_host, imap_port, imap_security, imap_username,
                status, auth_status, receive_status, send_status,
                listed_in_all_accounts, version, created_at, updated_at
    `).get(now, id, expectedVersion) as unknown as MailAccountSqlRow | undefined;
    return row ? this.mapMailAccountRow(row) : undefined;
  }

  public async deleteMailAccount(id: string, expectedVersion: number, now: string): Promise<boolean> {
    const result = this.database.prepare(`
      UPDATE mail_accounts
      SET status = 'deleted', deleted_at = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ? AND deleted_at IS NULL
    `).run(now, now, id, expectedVersion);
    return result.changes === 1;
  }
}
