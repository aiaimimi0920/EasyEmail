import type {
  MailAvatarClearCacheInput,
  MailAvatarClearCacheResult,
  MailAvatarResolveInput,
  MailAvatarSettings,
  MailAvatarSettingsUpdateInput,
  MailContactAvatarClearResult,
  MailContactAvatarSetInput,
  MailSenderAvatar,
} from "../domain/mail-avatar.js";

export interface GetMailAvatarSettingsHttpResponse {
  settings: MailAvatarSettings;
}

export type UpdateMailAvatarSettingsHttpRequest = MailAvatarSettingsUpdateInput;
export interface UpdateMailAvatarSettingsHttpResponse {
  settings: MailAvatarSettings;
}

export type ResolveMailSenderAvatarsHttpRequest = MailAvatarResolveInput;
export interface ResolveMailSenderAvatarsHttpResponse {
  avatars: MailSenderAvatar[];
}

export type SetMailContactAvatarHttpRequest = MailContactAvatarSetInput;
export interface SetMailContactAvatarHttpResponse {
  avatar: MailSenderAvatar;
}

export interface ClearMailContactAvatarHttpResponse {
  result: MailContactAvatarClearResult;
}

export type ClearMailAvatarCacheHttpRequest = MailAvatarClearCacheInput;
export interface ClearMailAvatarCacheHttpResponse {
  result: MailAvatarClearCacheResult;
}
