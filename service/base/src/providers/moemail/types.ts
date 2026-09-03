import type { CredentialSetDefinition } from "../../shared/index.js";

export interface MoemailConfig {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  preferredDomain?: string;
  expiryTimeMs: number;
  webSessionToken?: string;
  webCsrfToken?: string;
  webCallbackUrl?: string;
  webReferer?: string;
}

export interface MoemailMailboxCredentials {
  emailId: string;
  email: string;
  localPart?: string;
  domain?: string;
  credentialSetId?: string;
  credentialItemId?: string;
}

export interface MoemailMailboxListingEntry {
  emailId: string;
  email: string;
  createdAt?: string;
  expiresAt?: string;
}

export interface MoemailMessageSummary {
  messageId: string;
  sender?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  observedAt: string;
}

export interface MoemailMailboxAccessCheckResult {
  status: "accessible" | "missing" | MoemailClientError["kind"];
}

export interface ClassifiedMoemailFailure {
  kind: "auth" | "capacity" | "transient" | "provider";
  message: string;
  status?: number;
  mailboxConflict: boolean;
}

export class MoemailClientError extends Error {
  public constructor(
    message: string,
    public readonly kind: "auth" | "capacity" | "transient" | "provider",
    public readonly status?: number,
  ) {
    super(message);
    this.name = "MoemailClientError";
  }
}
