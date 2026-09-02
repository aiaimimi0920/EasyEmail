import type {
  MailAccount,
  MailAccountImapProfile,
  MailCredentialRef,
} from "../domain/account.js";

export interface MailCredentialResolveRequest {
  account: MailAccount;
  credentialRef: MailCredentialRef;
  useCase: "imap-test";
}

export type MailCredentialResolution =
  | { status: "resolved"; secret: string }
  | { status: "missing" }
  | { status: "unavailable" };

export interface MailCredentialResolver {
  resolveCredential(request: MailCredentialResolveRequest): Promise<MailCredentialResolution>;
}

export interface MailImapConnectionTestResult {
  authenticated: true;
  capabilitySummary: string;
}

export interface MailImapConnectionTester {
  testConnection(
    profile: MailAccountImapProfile,
    secret: string,
  ): Promise<MailImapConnectionTestResult>;
}

export interface MailAccountImapTestRequest {
  accountId: string;
  credentialRefId: string;
}

export interface MailAccountConnectivityDependencies {
  credentialResolver?: MailCredentialResolver;
  imapTester?: MailImapConnectionTester;
}
