export interface EasyEmailAvatarSettings {
  remoteEnabled: boolean;
  bimiEnabled: boolean;
  faviconEnabled: boolean;
  authEnabled: boolean;
}

export interface EasyEmailAvatarSettingsUpdateRequest {
  remoteEnabled?: boolean;
  bimiEnabled?: boolean;
  faviconEnabled?: boolean;
  authEnabled?: boolean;
}

export interface EasyEmailGetAvatarSettingsResponse {
  settings: EasyEmailAvatarSettings;
}

export interface EasyEmailUpdateAvatarSettingsResponse {
  settings: EasyEmailAvatarSettings;
}

export type EasyEmailAvatarAuthSignalStatus =
  | "pass"
  | "fail"
  | "published"
  | "missing"
  | "unknown";

export interface EasyEmailAvatarAuthSignal {
  status: EasyEmailAvatarAuthSignalStatus;
  detail: string;
}

export interface EasyEmailAvatarSenderAuth {
  spf: EasyEmailAvatarAuthSignal;
  dkim: EasyEmailAvatarAuthSignal;
  dmarc: EasyEmailAvatarAuthSignal;
  bimi: EasyEmailAvatarAuthSignal;
  certificate: EasyEmailAvatarAuthSignal;
}

export interface EasyEmailSenderAvatar {
  sender: string;
  cacheKey: string;
  domain: string;
  displayName: string;
  sourceKind: string;
  imageDataUrl?: string | null;
  builtinKind?: string | null;
  fallbackText: string;
  remoteUrl?: string | null;
  auth: EasyEmailAvatarSenderAuth;
  fetchedAt?: string | null;
  expiresAt?: string | null;
}

export interface EasyEmailResolveSenderAvatarsRequest {
  senders: string[];
}

export interface EasyEmailResolveSenderAvatarsResponse {
  avatars: EasyEmailSenderAvatar[];
}

export interface EasyEmailSetContactAvatarRequest {
  imageDataUrl: string;
  sender?: string | null;
}

export interface EasyEmailSetContactAvatarResponse {
  avatar: EasyEmailSenderAvatar;
}

export interface EasyEmailClearContactAvatarResult {
  contactId: string;
  cacheKey: string;
  cleared: boolean;
}

export interface EasyEmailClearContactAvatarResponse {
  result: EasyEmailClearContactAvatarResult;
}

export interface EasyEmailClearAvatarCacheQuery {
  includeContacts?: boolean;
}

export interface EasyEmailClearAvatarCacheResponse {
  result: {
    deletedCount: number;
  };
}
