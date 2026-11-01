export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OUTBOX?: R2Bucket;
  INBOX?: R2Bucket;
  APP_ORIGIN: string;
  REGISTRATION_TOKEN?: string;
  PROVIDER_CONFIG?: string;
  PROVIDER_SECRETS?: string;
  PROVIDER_ENDPOINT_ORIGINS?: string;
  MAILBOX_KEYRING?: string;
  IMAP_ENDPOINTS?: string;
  SMTP_ENDPOINTS?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
}

export interface Identity {
  userId: string;
  username: string;
  kind: "session" | "apiKey";
  credentialId: string;
  scopes: string[];
}

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  status: string;
}

export const SESSION_SECONDS = 7 * 24 * 60 * 60;
export const KEY_MAX_SECONDS = 90 * 24 * 60 * 60;
export const SESSION_COOKIE = "__Host-ee_session";
export const KEY_SCOPES = ["mailboxes:read", "mailboxes:write", "messages:read", "messages:write", "messages:send", "messages:schedule", "attachments:read", "attachments:write", "messages:delete", "mailboxes:delete", "messages:remote-delete", "mailboxes:remote-delete", "drafts:read", "drafts:write", "labels:read", "labels:write", "folders:read", "folders:write", "contacts:read", "contacts:write", "subscriptions:read", "subscriptions:write", "mail-accounts:read", "mail-accounts:write", "mail-accounts:sync", "mail-accounts:send", "mail-accounts:schedule", "mail-accounts:remote-flags", "mail-accounts:remote-move", "mail-accounts:remote-delete", "agent-services:read", "agent-services:write", "agent-accounts:read", "agent-accounts:write", "agent-accounts:sync", "agent-tasks:read", "agent-tasks:send", "agent-inbox:read", "agent-inbox:review", "agent-threads:write", "agent-threads:send", "agent-inbox:automate"] as const;
export const unixNow = () => Math.floor(Date.now() / 1000);
