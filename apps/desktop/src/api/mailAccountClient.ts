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
} from "./easyEmailHttpClient.ts";

export type AccountCredentialRefDto = {
  id: string;
  secret_backend: string;
  secret_key: string;
  credential_kind: string;
  auth_method: string;
  status: "active" | "missing" | "invalid" | "disabled";
};

export type AccountDto = {
  id: string;
  scope: string;
  kind: string;
  display_name: string;
  primary_address: string | null;
  provider_label: string | null;
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

export type ManualImapAccountCreateRequest = {
  display_name: string;
  email_address: string;
  imap_host: string;
  imap_port: number;
  imap_security: EasyEmailMailAccountImapSecurity;
  imap_username: string;
  imap_password: string;
};

export type NormalAccountAddDto = {
  account: AccountDto;
  credential_ref_id: string;
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
}

function isVersionedCredentialRef(secretKey: string): secretKey is `ref:v1:${string}` {
  return secretKey.startsWith("ref:v1:") && secretKey.length > "ref:v1:".length;
}

function toAccountDto(account: EasyEmailMailAccount): AccountDto {
  return {
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
}

function activeImapCredential(account: AccountDto): AccountCredentialRefDto {
  const credential = account.credential_refs.find(
    (candidate) =>
      candidate.credential_kind === "imap_password"
      && candidate.auth_method === "password"
      && candidate.status === "active",
  );
  if (!credential) {
    throw new Error("The account has no active IMAP password reference.");
  }
  return credential;
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
      const storedCredential = await credentials.storeImapPassword(request.imap_password);
      if (!isVersionedCredentialRef(storedCredential.secret_key)) {
        await credentials.deleteCredential(storedCredential.secret_key).catch(() => undefined);
        throw new Error("The desktop credential bridge returned an invalid opaque reference.");
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
          credentialRefs: [{
            secretBackend: storedCredential.secret_backend,
            secretKey: storedCredential.secret_key,
            credentialKind: storedCredential.credential_kind,
            authMethod: storedCredential.auth_method,
          }],
        });
      } catch (error: unknown) {
        await credentials.deleteCredential(storedCredential.secret_key).catch(() => undefined);
        throw error;
      }

      const credentialRef = response.account.credentialRefs.find(
        (candidate) => candidate.secretKey === storedCredential.secret_key,
      );
      if (!credentialRef) {
        await transport.deleteMailAccount(response.account.id, response.account.version).catch(() => undefined);
        await credentials.deleteCredential(storedCredential.secret_key).catch(() => undefined);
        throw new Error("The account response omitted its stored credential reference.");
      }
      return {
        account: toAccountDto(response.account),
        credential_ref_id: credentialRef.id,
      };
    },

    async testImap(account: AccountDto): Promise<NormalImapConnectionTestDto> {
      const credential = activeImapCredential(account);
      const response = await transport.testMailAccountImap({
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
