import type { DesktopCredentialTransport } from "./desktopCredentialClient.ts";
import type {
  EasyEmailMailAccount,
  EasyEmailMailAccountCreateRequest,
  EasyEmailMailAccountImapSecurity,
  EasyEmailMailAccountImapTestRequest,
  EasyEmailMailAccountImapTestResponse,
  EasyEmailMailAccountListQuery,
  EasyEmailMailAccountResponse,
  EasyEmailMailAccountsResponse,
  EasyEmailMailAccountSmtpSecurity,
  EasyEmailMailAccountSmtpTestRequest,
  EasyEmailMailAccountSmtpTestResponse,
} from "./easyEmailHttpClient.ts";

export type AccountCredentialRefDto = {
  id: string;
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
  status: "active" | "missing" | "invalid" | "disabled";
};

export type AccountSmtpProfileDto = {
  host: string;
  port: number;
  security: EasyEmailMailAccountSmtpSecurity;
  username: string;
};

export type AccountDto = {
  id: string;
  scope: string;
  kind: string;
  display_name: string;
  primary_address: string | null;
  provider_label: string | null;
  smtp?: AccountSmtpProfileDto | null;
  status: string;
  auth_status: string;
  receive_status: string;
  send_status: string;
  listed_in_all_accounts: boolean;
  version: number;
  credential_refs: AccountCredentialRefDto[];
};

export type NormalImapConnectionTestDto = {
  authenticated: boolean;
  capability_summary: string;
};

export type NormalSmtpConnectionTestDto = {
  authenticated: boolean;
  capability_summary: string;
};

export type ManualImapAccountCreateRequest = {
  display_name: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  imap_security: EasyEmailMailAccountImapSecurity;
  imap_username: string;
  imap_password: string;
  smtp_host?: string;
  smtp_port?: number;
  smtp_security?: EasyEmailMailAccountSmtpSecurity;
  smtp_username?: string;
  smtp_password?: string;
};

export type NormalAccountAddDto = {
  account: AccountDto;
  credential_ref_id: string;
  smtp_credential_ref_id?: string | null;
};

export type NormalAccountDeleteDto = {
  id: string;
  credential_cleanup_complete: boolean;
};

export interface MailAccountHttpTransport {
  listMailAccounts(query?: EasyEmailMailAccountListQuery): Promise<EasyEmailMailAccountsResponse>;
  createMailAccount(request: EasyEmailMailAccountCreateRequest): Promise<EasyEmailMailAccountResponse>;
  disableMailAccount(accountId: string, expectedVersion: number): Promise<EasyEmailMailAccountResponse>;
  deleteMailAccount(accountId: string, expectedVersion: number): Promise<{ deleted: { id: string } }>;
  testMailAccountImap(request: EasyEmailMailAccountImapTestRequest): Promise<EasyEmailMailAccountImapTestResponse>;
  testMailAccountSmtp(request: EasyEmailMailAccountSmtpTestRequest): Promise<EasyEmailMailAccountSmtpTestResponse>;
}

function isVersionedCredentialRef(secretKey: string): secretKey is `ref:v1:${string}` {
  return secretKey.startsWith("ref:v1:") && secretKey.length > "ref:v1:".length;
}

function toAccountDto(account: EasyEmailMailAccount): AccountDto {
  const dto: AccountDto = {
    id: account.id,
    scope: account.scope,
    kind: account.kind,
    display_name: account.displayName,
    primary_address: account.primaryAddress ?? null,
    provider_label: account.providerLabel ?? null,
    status: account.status,
    auth_status: account.authStatus,
    receive_status: account.receiveStatus,
    send_status: account.sendStatus,
    listed_in_all_accounts: account.listedInAllAccounts,
    version: account.version,
    credential_refs: account.credentialRefs.map((credential) => ({
      id: credential.id,
      secret_backend: credential.secretBackend,
      secret_key: credential.secretKey,
      credential_kind: credential.credentialKind,
      auth_method: credential.authMethod,
      status: credential.status,
    })),
  };
  if (account.smtp) {
    dto.smtp = {
      host: account.smtp.host,
      port: account.smtp.port,
      security: account.smtp.security,
      username: account.smtp.username,
    };
  }
  return dto;
}

function selectTestablePasswordCredential(
  account: AccountDto,
  credentialKind: "imap_password" | "smtp_password",
): AccountCredentialRefDto | undefined {
  const candidates = account.credential_refs.filter(
    (candidate) =>
      candidate.credential_kind === credentialKind
      && candidate.auth_method === "password",
  );
  return (
    candidates.find((candidate) => candidate.status === "active")
    ?? candidates.find((candidate) => candidate.status === "missing")
  );
}

function testableImapCredential(account: AccountDto): AccountCredentialRefDto {
  const credential = selectTestablePasswordCredential(account, "imap_password");
  if (!credential) {
    throw new Error("The account has no testable IMAP password reference.");
  }
  return credential;
}

function testableSmtpCredential(account: AccountDto): AccountCredentialRefDto {
  const credential = selectTestablePasswordCredential(account, "smtp_password");
  if (!credential) {
    throw new Error("The account has no testable SMTP password reference.");
  }
  return credential;
}

export function hasTestableSmtpCredential(account: AccountDto): boolean {
  return Boolean(selectTestablePasswordCredential(account, "smtp_password"));
}

export function createMailAccountClient(
  transport: MailAccountHttpTransport,
  credentials: DesktopCredentialTransport,
) {
  return {
    async listNormalAccounts(): Promise<AccountDto[]> {
      const accounts: AccountDto[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const response = await transport.listMailAccounts({ scope: "normal", limit: 100, cursor });
        accounts.push(...response.accounts.map(toAccountDto));
        if (response.nextCursor && seenCursors.has(response.nextCursor)) {
          throw new Error("Account pagination returned a repeated cursor.");
        }
        if (response.nextCursor) seenCursors.add(response.nextCursor);
        cursor = response.nextCursor;
      } while (cursor);
      return accounts;
    },

    async addManualImapAccount(
      request: ManualImapAccountCreateRequest,
    ): Promise<NormalAccountAddDto> {
      const storedSecretKeys: string[] = [];
      const cleanupStoredCredentials = async () => {
        for (const secretKey of storedSecretKeys) {
          await credentials.deleteCredential(secretKey).catch(() => undefined);
        }
      };

      const storedImapCredential = await credentials.storeImapPassword(request.imap_password);
      storedSecretKeys.push(storedImapCredential.secret_key);
      if (!isVersionedCredentialRef(storedImapCredential.secret_key)) {
        await cleanupStoredCredentials();
        throw new Error("The desktop credential bridge returned an invalid opaque reference.");
      }

      const credentialRefs: NonNullable<EasyEmailMailAccountCreateRequest["credentialRefs"]> = [{
        secretBackend: storedImapCredential.secret_backend,
        secretKey: storedImapCredential.secret_key,
        credentialKind: storedImapCredential.credential_kind,
        authMethod: storedImapCredential.auth_method,
      }];

      let storedSmtpSecretKey: string | undefined;
      let smtpProfileInput: EasyEmailMailAccountCreateRequest["smtp"];
      if (request.smtp_host && request.smtp_port && request.smtp_security) {
        let storedSmtpCredential;
        try {
          storedSmtpCredential = await credentials.storeSmtpPassword(
            request.smtp_password ?? request.imap_password,
          );
        } catch (error: unknown) {
          await cleanupStoredCredentials();
          throw error;
        }
        storedSecretKeys.push(storedSmtpCredential.secret_key);
        if (!isVersionedCredentialRef(storedSmtpCredential.secret_key)) {
          await cleanupStoredCredentials();
          throw new Error("The desktop credential bridge returned an invalid opaque SMTP reference.");
        }
        storedSmtpSecretKey = storedSmtpCredential.secret_key;
        smtpProfileInput = {
          host: request.smtp_host,
          port: request.smtp_port,
          security: request.smtp_security,
          username: request.smtp_username ?? request.imap_username,
        };
        credentialRefs.push({
          secretBackend: storedSmtpCredential.secret_backend,
          secretKey: storedSmtpCredential.secret_key,
          credentialKind: storedSmtpCredential.credential_kind,
          authMethod: storedSmtpCredential.auth_method,
        });
      }

      let response: EasyEmailMailAccountResponse;
      try {
        response = await transport.createMailAccount({
          scope: "normal",
          kind: "normal_long_lived",
          displayName: request.display_name,
          primaryAddress: request.email_address,
          imap: {
            host: request.imap_host,
            port: request.imap_port,
            security: request.imap_security,
            username: request.imap_username,
          },
          ...(smtpProfileInput ? { smtp: smtpProfileInput } : {}),
          credentialRefs,
        });
      } catch (error: unknown) {
        await cleanupStoredCredentials();
        throw error;
      }

      const credentialRef = response.account.credentialRefs.find(
        (candidate) => candidate.secretKey === storedImapCredential.secret_key,
      );
      const smtpCredentialRef = storedSmtpSecretKey
        ? response.account.credentialRefs.find(
            (candidate) => candidate.secretKey === storedSmtpSecretKey,
          )
        : undefined;
      if (!credentialRef || (storedSmtpSecretKey && !smtpCredentialRef)) {
        await transport.deleteMailAccount(response.account.id, response.account.version).catch(() => undefined);
        await cleanupStoredCredentials();
        throw new Error("The account response omitted its stored credential reference.");
      }

      return {
        account: toAccountDto(response.account),
        credential_ref_id: credentialRef.id,
        ...(storedSmtpSecretKey ? { smtp_credential_ref_id: smtpCredentialRef?.id ?? null } : {}),
      };
    },

    async testImap(account: AccountDto): Promise<NormalImapConnectionTestDto> {
      // Newly stored refs are intentionally persisted as `missing` until the
      // broker proves that the secret exists. The first connection test must
      // therefore reach the core instead of being rejected in the renderer.
      const credential = testableImapCredential(account);
      const response = await transport.testMailAccountImap({
        accountId: account.id,
        credentialRefId: credential.id,
      });
      return {
        authenticated: response.result.authenticated,
        capability_summary: response.result.capabilitySummary,
      };
    },

    async testSmtp(account: AccountDto): Promise<NormalSmtpConnectionTestDto> {
      const credential = testableSmtpCredential(account);
      const response = await transport.testMailAccountSmtp({
        accountId: account.id,
        credentialRefId: credential.id,
      });
      return {
        authenticated: response.result.authenticated,
        capability_summary: response.result.capabilitySummary,
      };
    },

    async disableAccount(account: AccountDto): Promise<AccountDto> {
      return toAccountDto((await transport.disableMailAccount(account.id, account.version)).account);
    },

    async deleteAccount(account: AccountDto): Promise<NormalAccountDeleteDto> {
      const response = await transport.deleteMailAccount(account.id, account.version);
      let credentialCleanupComplete = true;
      for (const credential of account.credential_refs) {
        if (
          credential.secret_backend !== "windows_credential_manager"
          || !credential.secret_key.startsWith("ref:v1:desktop/")
        ) {
          continue;
        }
        try {
          await credentials.deleteCredential(credential.secret_key);
        } catch {
          credentialCleanupComplete = false;
        }
      }
      return {
        id: response.deleted.id,
        credential_cleanup_complete: credentialCleanupComplete,
      };
    },
  };
}
