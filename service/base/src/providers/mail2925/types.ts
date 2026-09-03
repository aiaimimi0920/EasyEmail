import type { CredentialSelection, CredentialSetDefinition } from "../../shared/index.js";

export interface Mail2925Config {
  instanceId: string;
  namespace: string;
  apiBase: string;
  credentialSets: CredentialSetDefinition[];
  domain: string;
  folderName: string;
  aliasSeparator: string;
  aliasSuffixLength: number;
  timeoutSeconds: number;
  jwtToken?: string;
  deviceUid?: string;
  cookieHeader?: string;
}

export interface Mail2925MailboxRefPayload {
  aliasAddress: string;
  accountEmail: string;
  folderName?: string;
  credentialSetId?: string;
  credentialItemId?: string;
  createdAt?: string;
}

export interface Mail2925RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  formBody?: Record<string, string | number | boolean | undefined>;
  token?: string;
  extraHeaders?: Record<string, string>;
}

export interface Mail2925AccountCredential {
  selection: CredentialSelection;
  username: string;
  password: string;
  accountEmail: string;
  localPart: string;
  domain: string;
}

export interface Mail2925TokenCacheEntry {
  token: string;
  expiresAtMs: number;
}
