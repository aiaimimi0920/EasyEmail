import type { InvokeCommand } from "./invokeCommand";

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

export function createAvatarSettingsClient(invokeCommand: InvokeCommand) {
  return {
    getAvatarSettings(): Promise<AvatarSettingsDto> {
      return invokeCommand<AvatarSettingsDto>("avatar_get_settings");
    },
    updateAvatarSettings(
      request: AvatarSettingsUpdateRequest,
    ): Promise<AvatarSettingsDto> {
      return invokeCommand<AvatarSettingsDto>("avatar_update_settings", {
        request,
      });
    },
    clearAvatarCache(
      request: AvatarClearCacheRequest,
    ): Promise<AvatarClearCacheDto> {
      return invokeCommand<AvatarClearCacheDto>("avatar_clear_cache", {
        request,
      });
    },
  };
}
