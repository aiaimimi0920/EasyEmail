import type { SenderAvatarDto } from "../mail/senderAvatar.ts";
import type {
  EasyEmailAvatarSettings,
  EasyEmailAvatarSettingsUpdateRequest,
  EasyEmailClearAvatarCacheQuery,
  EasyEmailClearAvatarCacheResponse,
  EasyEmailClearContactAvatarResponse,
  EasyEmailGetAvatarSettingsResponse,
  EasyEmailResolveSenderAvatarsRequest,
  EasyEmailResolveSenderAvatarsResponse,
  EasyEmailSenderAvatar,
  EasyEmailSetContactAvatarRequest,
  EasyEmailSetContactAvatarResponse,
  EasyEmailUpdateAvatarSettingsResponse,
} from "./easyEmailHttpClient.ts";

export type AvatarSettingsDto = {
  remote_enabled: boolean;
  bimi_enabled: boolean;
  favicon_enabled: boolean;
  auth_enabled: boolean;
};

export type AvatarSettingsUpdateRequest = {
  remote_enabled: boolean;
  bimi_enabled: boolean;
  favicon_enabled: boolean;
  auth_enabled: boolean;
};

export type AvatarClearCacheRequest = {
  include_contacts: boolean;
};

export type AvatarClearCacheDto = {
  deleted_count: number;
};

export type AvatarResolveSendersRequest = {
  senders: string[];
};

export type AvatarSetContactRequest = {
  sender: string;
  image_data_url: string;
  contact_id?: string | null;
};

export type AvatarClearContactRequest = {
  sender: string;
  contact_id?: string | null;
};

export type AvatarClearContactDto = {
  contact_id: string;
  cache_key: string;
  cleared: boolean;
};

export interface AvatarHttpTransport {
  getMailAvatarSettings(): Promise<EasyEmailGetAvatarSettingsResponse>;
  updateMailAvatarSettings(
    request: EasyEmailAvatarSettingsUpdateRequest,
  ): Promise<EasyEmailUpdateAvatarSettingsResponse>;
  resolveMailSenderAvatars(
    request: EasyEmailResolveSenderAvatarsRequest,
  ): Promise<EasyEmailResolveSenderAvatarsResponse>;
  setMailContactAvatar(
    contactId: string,
    request: EasyEmailSetContactAvatarRequest,
  ): Promise<EasyEmailSetContactAvatarResponse>;
  clearMailContactAvatar(
    contactId: string,
  ): Promise<EasyEmailClearContactAvatarResponse>;
  clearMailAvatarCache(
    query?: EasyEmailClearAvatarCacheQuery,
  ): Promise<EasyEmailClearAvatarCacheResponse>;
}

function toAvatarSettingsDto(settings: EasyEmailAvatarSettings): AvatarSettingsDto {
  return {
    remote_enabled: settings.remoteEnabled,
    bimi_enabled: settings.bimiEnabled,
    favicon_enabled: settings.faviconEnabled,
    auth_enabled: settings.authEnabled,
  };
}

function toSenderAvatarDto(avatar: EasyEmailSenderAvatar): SenderAvatarDto {
  return {
    sender: avatar.sender,
    cache_key: avatar.cacheKey,
    domain: avatar.domain,
    display_name: avatar.displayName,
    source_kind: avatar.sourceKind,
    image_data_url: avatar.imageDataUrl ?? null,
    builtin_kind: avatar.builtinKind ?? null,
    fallback_text: avatar.fallbackText,
    remote_url: avatar.remoteUrl ?? null,
    fetched_at: avatar.fetchedAt ?? null,
    expires_at: avatar.expiresAt ?? null,
  };
}

export function createAvatarSettingsClient(transport: AvatarHttpTransport) {
  return {
    async getAvatarSettings(): Promise<AvatarSettingsDto> {
      const response = await transport.getMailAvatarSettings();
      return toAvatarSettingsDto(response.settings);
    },

    async updateAvatarSettings(
      request: AvatarSettingsUpdateRequest,
    ): Promise<AvatarSettingsDto> {
      const response = await transport.updateMailAvatarSettings({
        remoteEnabled: request.remote_enabled,
        bimiEnabled: request.bimi_enabled,
        faviconEnabled: request.favicon_enabled,
        authEnabled: request.auth_enabled,
      });
      return toAvatarSettingsDto(response.settings);
    },

    async resolveSenderAvatars(
      request: AvatarResolveSendersRequest,
    ): Promise<SenderAvatarDto[]> {
      const response = await transport.resolveMailSenderAvatars({
        senders: request.senders,
      });
      return response.avatars.map(toSenderAvatarDto);
    },

    async setContactAvatar(request: AvatarSetContactRequest): Promise<SenderAvatarDto> {
      const targetId = request.contact_id?.trim() || request.sender;
      const response = await transport.setMailContactAvatar(targetId, {
        imageDataUrl: request.image_data_url,
        sender: request.sender,
      });
      return toSenderAvatarDto(response.avatar);
    },

    async clearContactAvatar(
      request: AvatarClearContactRequest,
    ): Promise<AvatarClearContactDto> {
      const targetId = request.contact_id?.trim() || request.sender;
      const response = await transport.clearMailContactAvatar(targetId);
      return {
        contact_id: response.result.contactId,
        cache_key: response.result.cacheKey,
        cleared: response.result.cleared,
      };
    },

    async clearAvatarCache(
      request: AvatarClearCacheRequest,
    ): Promise<AvatarClearCacheDto> {
      const response = await transport.clearMailAvatarCache({
        includeContacts: request.include_contacts,
      });
      return {
        deleted_count: response.result.deletedCount,
      };
    },
  };
}
