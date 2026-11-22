import type {
  MailAccount,
  MailAccountImapProfile,
  MailAccountSmtpProfile,
  MailCredentialRef,
} from "../domain/account.js";

export type MailCredentialUseCase =
  | "imap-test"
  | "imap-sync"
  | "imap-action"
  | "smtp-test"
  | "smtp-send";

export interface MailCredentialResolveRequest {
  account: MailAccount;
  credentialRef: MailCredentialRef;
  useCase: MailCredentialUseCase;
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

export interface MailSmtpConnectionTestResult {
  authenticated: true;
  capabilitySummary: string;
}

export interface MailSmtpSendEnvelope {
  fromAddress: string;
  fromName?: string;
  toAddresses: string[];
  ccAddresses: string[];
  bccAddresses: string[];
  subject: string;
  bodyText: string;
  bodyHtml?: string;
  rfcMessageId?: string;
}

export interface MailSmtpSendResult {
  providerMessageId?: string;
}

export interface MailSmtpTransport {
  testConnection(
    profile: MailAccountSmtpProfile,
    secret: string,
  ): Promise<MailSmtpConnectionTestResult>;
  sendMessage(
    profile: MailAccountSmtpProfile,
    secret: string,
    envelope: MailSmtpSendEnvelope,
  ): Promise<MailSmtpSendResult>;
}

export interface MailAccountImapTestRequest {
  accountId: string;
  credentialRefId: string;
}

export interface MailAccountSmtpTestRequest {
  accountId: string;
  credentialRefId: string;
}

export interface MailAccountConnectivityDependencies {
  credentialResolver?: MailCredentialResolver;
  imapTester?: MailImapConnectionTester;
  smtpTransport?: MailSmtpTransport;
}
