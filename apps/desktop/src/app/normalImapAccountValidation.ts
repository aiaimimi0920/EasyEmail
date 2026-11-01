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
  if (!fields.imapPassword.trim()) {
    return invalid(
      "NORMAL_IMAP_AUTHORIZATION_REQUIRED",
      "Enter the mailbox authorization code or IMAP password.",
    );
  }

  return {
    ok: true,
    request: {
      display_name: displayName,
      email_address: emailAddress,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_security: fields.imapSecurity,
      imap_username: fields.imapUsername.trim() || emailAddress,
      imap_password: fields.imapPassword,
    },
  };
}
