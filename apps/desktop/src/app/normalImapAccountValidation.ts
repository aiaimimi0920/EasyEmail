import type { ManualImapAccountCreateRequest } from "../api/mailAccountClient";
import type { ErrorDto } from "./appTypes";

export type NormalImapAccountFields = {
  displayName: string;
  emailAddress: string;
  imapHost: string;
  imapPort: string;
  imapSecurity: ManualImapAccountCreateRequest["imap_security"];
  imapUsername: string;
  imapPassword: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecurity?: NonNullable<ManualImapAccountCreateRequest["smtp_security"]>;
  smtpUsername?: string;
};

export type NormalImapAccountValidationResult =
  | { ok: true; request: ManualImapAccountCreateRequest }
  | { ok: false; error: ErrorDto };

const BASIC_EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function invalid(code: string, userMessage: string): NormalImapAccountValidationResult {
  return {
    ok: false,
    error: {
      code,
      user_message: userMessage,
      correlation_id: "desktop-validation",
    },
  };
}

export function validateNormalImapAccount(
  fields: NormalImapAccountFields,
): NormalImapAccountValidationResult {
  const displayName = fields.displayName.trim();
  const emailAddress = fields.emailAddress.trim().toLowerCase();
  const imapHost = fields.imapHost.trim();
  const normalizedPort = fields.imapPort.trim();
  const smtpHost = fields.smtpHost?.trim() ?? "";
  const normalizedSmtpPort = fields.smtpPort?.trim() ?? "465";

  if (!displayName) {
    return invalid("NORMAL_IMAP_DISPLAY_NAME_REQUIRED", "Enter a display name for this mailbox.");
  }
  if (!BASIC_EMAIL_ADDRESS.test(emailAddress)) {
    return invalid("NORMAL_IMAP_EMAIL_INVALID", "Enter a valid mailbox email address.");
  }
  if (!imapHost) {
    return invalid("NORMAL_IMAP_HOST_REQUIRED", "Enter the IMAP server host.");
  }
  if (!/^\d+$/.test(normalizedPort)) {
    return invalid("NORMAL_IMAP_PORT_INVALID", "Enter an IMAP port from 1 to 65535.");
  }
  const imapPort = Number(normalizedPort);
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65_535) {
    return invalid("NORMAL_IMAP_PORT_INVALID", "Enter an IMAP port from 1 to 65535.");
  }
  let smtpPort: number | undefined;
  if (smtpHost) {
    if (!/^\d+$/.test(normalizedSmtpPort)) {
      return invalid("NORMAL_SMTP_PORT_INVALID", "Enter an SMTP port from 1 to 65535.");
    }
    smtpPort = Number(normalizedSmtpPort);
    if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65_535) {
      return invalid("NORMAL_SMTP_PORT_INVALID", "Enter an SMTP port from 1 to 65535.");
    }
  }
  if (!fields.imapPassword.trim()) {
    return invalid(
      "NORMAL_IMAP_AUTHORIZATION_REQUIRED",
      "Enter the mailbox authorization code or IMAP password.",
    );
  }

  const imapUsername = fields.imapUsername.trim() || emailAddress;
  const request: ManualImapAccountCreateRequest = {
    display_name: displayName,
    email_address: emailAddress,
    imap_host: imapHost,
    imap_port: imapPort,
    imap_security: fields.imapSecurity,
    imap_username: imapUsername,
    imap_password: fields.imapPassword,
  };
  if (smtpHost && smtpPort !== undefined) {
    request.smtp_host = smtpHost;
    request.smtp_port = smtpPort;
    request.smtp_security = fields.smtpSecurity ?? "tls";
    request.smtp_username = fields.smtpUsername?.trim() || imapUsername;
    request.smtp_password = fields.imapPassword;
  }

  return {
    ok: true,
    request,
  };
}
