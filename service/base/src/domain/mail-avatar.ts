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

export interface MailAvatarCachedRecord {
  cacheKey: string;
  senderDomain: string;
  normalizedSender: string;
  sourceKind: string;
  imageMime?: string;
  imageBytes?: Uint8Array;
  remoteUrl?: string;
  fallbackText: string;
  status: "ok" | "failed";
  auth: MailAvatarSenderAuth;
  lastError?: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface MailContactAvatarOverrideRecord {
  senderKey: string;
  contactId?: string;
  normalizedSender: string;
  senderDomain: string;
  imageMime: string;
  imageBytes: Uint8Array;
  displayName: string;
  updatedAt: string;
}

export interface MailAvatarContactLookup {
  id: string;
  displayName: string;
  emailAddress: string;
}

export interface MailAvatarSaveCacheInput {
  cacheKey: string;
  senderDomain: string;
  normalizedSender: string;
  sourceKind: string;
  imageMime: string;
  imageBytes: Uint8Array;
  remoteUrl: string;
  fallbackText: string;
  auth: MailAvatarSenderAuth;
  fetchedAt: string;
  expiresAt: string;
}

export interface MailAvatarSaveFailedCacheInput {
  cacheKey: string;
  senderDomain: string;
  normalizedSender: string;
  fallbackText: string;
  auth: MailAvatarSenderAuth;
  lastError: string;
  fetchedAt: string;
  expiresAt: string;
}

export interface MailContactAvatarUpsertInput {
  senderKey: string;
  contactId?: string;
  normalizedSender: string;
  senderDomain: string;
  imageMime: string;
  imageBytes: Uint8Array;
  displayName: string;
  now: string;
}

export interface MailAvatarRepository {
  getAvatarSettings(): Promise<MailAvatarSettings>;
  saveAvatarSettings(settings: MailAvatarSettings, now: string): Promise<MailAvatarSettings>;
  clearAvatarCache(includeContacts: boolean): Promise<number>;
  lookupContactForAvatar(contactId: string): Promise<MailAvatarContactLookup | undefined>;
  getContactAvatarOverride(senderKey: string): Promise<MailContactAvatarOverrideRecord | undefined>;
  upsertContactAvatarOverride(
    input: MailContactAvatarUpsertInput,
  ): Promise<MailContactAvatarOverrideRecord>;
  deleteContactAvatarOverride(senderKey: string): Promise<boolean>;
  getCachedSenderAvatar(cacheKey: string): Promise<MailAvatarCachedRecord | undefined>;
  saveCachedSenderAvatar(input: MailAvatarSaveCacheInput): Promise<void>;
  saveFailedSenderAvatar(input: MailAvatarSaveFailedCacheInput): Promise<void>;
}
