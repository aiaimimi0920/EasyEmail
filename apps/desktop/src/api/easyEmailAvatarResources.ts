import type {
  EasyEmailAvatarSettingsUpdateRequest,
  EasyEmailClearAvatarCacheQuery,
  EasyEmailClearAvatarCacheResponse,
  EasyEmailClearContactAvatarResponse,
  EasyEmailGetAvatarSettingsResponse,
  EasyEmailResolveSenderAvatarsRequest,
  EasyEmailResolveSenderAvatarsResponse,
  EasyEmailSetContactAvatarRequest,
  EasyEmailSetContactAvatarResponse,
  EasyEmailUpdateAvatarSettingsResponse,
} from "./easyEmailAvatarTypes.ts";
import type { EasyEmailRequestTransport } from "./easyEmailHttpTransport.ts";
import { EASY_EMAIL_CORE_ROUTES } from "./easyEmailRoutes.ts";

export function createEasyEmailAvatarResources(request: EasyEmailRequestTransport) {
  return {
    getMailAvatarSettings(): Promise<EasyEmailGetAvatarSettingsResponse> {
      return request<EasyEmailGetAvatarSettingsResponse>({
        path: EASY_EMAIL_CORE_ROUTES.avatarSettings,
      });
    },

    updateMailAvatarSettings(
      body: EasyEmailAvatarSettingsUpdateRequest,
    ): Promise<EasyEmailUpdateAvatarSettingsResponse> {
      return request<EasyEmailUpdateAvatarSettingsResponse>({
        method: "PATCH",
        path: EASY_EMAIL_CORE_ROUTES.avatarSettings,
        body,
      });
    },

    resolveMailSenderAvatars(
      body: EasyEmailResolveSenderAvatarsRequest,
    ): Promise<EasyEmailResolveSenderAvatarsResponse> {
      return request<EasyEmailResolveSenderAvatarsResponse>({
        method: "POST",
        path: EASY_EMAIL_CORE_ROUTES.avatarResolve,
        body,
      });
    },

    setMailContactAvatar(
      contactId: string,
      body: EasyEmailSetContactAvatarRequest,
    ): Promise<EasyEmailSetContactAvatarResponse> {
      return request<EasyEmailSetContactAvatarResponse>({
        method: "PUT",
        path: EASY_EMAIL_CORE_ROUTES.avatarContact(contactId),
        body,
      });
    },

    clearMailContactAvatar(contactId: string): Promise<EasyEmailClearContactAvatarResponse> {
      return request<EasyEmailClearContactAvatarResponse>({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.avatarContact(contactId),
      });
    },

    clearMailAvatarCache(
      query: EasyEmailClearAvatarCacheQuery = {},
    ): Promise<EasyEmailClearAvatarCacheResponse> {
      return request<EasyEmailClearAvatarCacheResponse>({
        method: "DELETE",
        path: EASY_EMAIL_CORE_ROUTES.avatarCache,
        query: {
          includeContacts: query.includeContacts,
        },
      });
    },
  };
}
