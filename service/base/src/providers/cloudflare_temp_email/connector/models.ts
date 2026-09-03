export interface CloudflareTempEmailConfig {
  baseUrl: string;
  customAuth?: string;
  adminAuth?: string;
  domain?: string;
  domains: string[];
  randomSubdomainDomains: string[];
  timeoutSeconds: number;
}

export interface CloudflareTempMailboxCredentials {
  address: string;
  jwt: string;
}

export interface CloudflareTempEmailSendResult {
  deliveryMode: "mailbox_token" | "admin_delegate";
  detail?: string;
}

export interface MailCreateAddressResponse {
  address?: string;
  jwt?: string;
}

export interface MailDeleteAddressResponse {
  success?: boolean;
}

export interface MailCreateMailItem {
  id?: number;
  source?: string;
  from?: string;
  subject?: string;
  raw?: string;
}

export interface MailCreateParsedMailResponse {
  sender?: string;
  subject?: string;
  text?: string;
  html?: string;
}

export interface CloudflareTempAdminAddressRecord {
  id?: number | string;
  name?: string;
}

export function encodeCloudflareTempMailboxRef(instanceId: string, mailbox: CloudflareTempMailboxCredentials): string {
  return `cloudflare_temp_email:${instanceId}:${encodeURIComponent(JSON.stringify(mailbox))}`;
}

export function decodeCloudflareTempMailboxRef(mailboxRef: string, expectedInstanceId: string): CloudflareTempMailboxCredentials | undefined {
  const prefix = `cloudflare_temp_email:${expectedInstanceId}:`;
  if (!mailboxRef.startsWith(prefix)) {
    return undefined;
  }

  try {
    const payload = JSON.parse(decodeURIComponent(mailboxRef.slice(prefix.length))) as Record<string, unknown>;
    const address = typeof payload.address === "string" ? payload.address.trim() : "";
    const jwt = typeof payload.jwt === "string" ? payload.jwt.trim() : "";
    if (!address || !jwt) {
      return undefined;
    }

    return { address, jwt };
  } catch {
    return undefined;
  }
}

