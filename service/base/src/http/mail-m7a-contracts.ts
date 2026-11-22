import type {
  EasyEmailClientSettings,
  EasyEmailClientSettingsUpdateInput,
  EasyEmailConnectionHealth,
  EasyEmailConnectionTestInput,
  MailNewsletterSubscription,
  MailNewsletterSubscriptionActionResult,
  MailNewsletterSubscriptionListQuery,
  MailNewsletterSubscriptionUpdateInput,
  PromoteMailboxSessionInput,
  PromoteMailboxSessionResult,
} from "../domain/mail-extensions.js";

export type PromoteMailboxHttpRequest = PromoteMailboxSessionInput;
export type PromoteMailboxHttpResponse = PromoteMailboxSessionResult;

export type ListNewsletterSubscriptionsHttpRequest = MailNewsletterSubscriptionListQuery;
export interface ListNewsletterSubscriptionsHttpResponse {
  subscriptions: MailNewsletterSubscription[];
}

export type UpdateNewsletterSubscriptionHttpRequest = MailNewsletterSubscriptionUpdateInput;
export interface UpdateNewsletterSubscriptionHttpResponse {
  action: MailNewsletterSubscriptionActionResult;
}

export interface GetEasyEmailSettingsHttpResponse {
  settings: EasyEmailClientSettings;
}

export type UpdateEasyEmailSettingsHttpRequest = EasyEmailClientSettingsUpdateInput;
export interface UpdateEasyEmailSettingsHttpResponse {
  settings: EasyEmailClientSettings;
}

export type TestEasyEmailConnectionHttpRequest = EasyEmailConnectionTestInput;
export interface TestEasyEmailConnectionHttpResponse {
  health: EasyEmailConnectionHealth;
}
