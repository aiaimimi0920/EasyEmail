export interface MailAvatarSettings {
  remoteEnabled: boolean;
  bimiEnabled: boolean;
  faviconEnabled: boolean;
  authEnabled: boolean;
}

export interface MailAvatarSettingsUpdateInput {
  remoteEnabled?: boolean;
  bimiEnabled?: boolean;
  faviconEnabled?: boolean;
  authEnabled?: boolean;
}

export type MailAvatarAuthSignalStatus =
  | "pass"
  | "fail"
  | "published"
  | "missing"
  | "unknown";

export interface MailAvatarAuthSignal {
  status: MailAvatarAuthSignalStatus;
  detail: string;
}

export interface MailAvatarSenderAuth {
  spf: MailAvatarAuthSignal;
  dkim: MailAvatarAuthSignal;
  dmarc: MailAvatarAuthSignal;
  bimi: MailAvatarAuthSignal;
  certificate: MailAvatarAuthSignal;
}

export interface MailSenderAvatar {
  sender: string;
  cacheKey: string;
  domain: string;
  displayName: string;
  sourceKind: string;
  imageDataUrl?: string | null;
  builtinKind?: string | null;
  fallbackText: string;
  remoteUrl?: string | null;
  auth: MailAvatarSenderAuth;
  fetchedAt?: string | null;
  expiresAt?: string | null;
}

export interface MailAvatarResolveInput {
  senders: string[];
}

export interface MailContactAvatarSetInput {
  imageDataUrl: string;
  sender?: string | null;
}

export interface MailContactAvatarClearResult {
  contactId: string;
  cacheKey: string;
  cleared: boolean;
}

export interface MailAvatarClearCacheInput {
  includeContacts?: boolean;
}

export interface MailAvatarClearCacheResult {
  deletedCount: number;
}
