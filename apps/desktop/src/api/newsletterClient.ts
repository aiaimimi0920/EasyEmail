import type { InvokeCommand } from "./invokeCommand";

export type NewsletterSubscriptionDto = {
  id: string;
  list_id: string;
  sender_address: string;
  name: string;
  received_message_count: number;
  unread_message_count: number;
  last_received_at: string;
  unsubscribe_methods: string[];
  spam: boolean;
  hidden: boolean;
};

export type NewsletterSubscriptionActionDto = {
  account_id: string;
  subscription_id: string;
  hidden: boolean;
  changed: boolean;
};

export type NewsletterSubscriptionListRequest = {
  account_id: string;
};

export type NewsletterSubscriptionSetHiddenRequest = {
  account_id: string;
  subscription_id: string;
  hidden: boolean;
};

export function createNewsletterClient(invokeCommand: InvokeCommand) {
  return {
    listNewsletterSubscriptions(
      request: NewsletterSubscriptionListRequest,
    ): Promise<NewsletterSubscriptionDto[]> {
      return invokeCommand<NewsletterSubscriptionDto[]>(
        "newsletter_subscription_list",
        { request },
      );
    },
    setNewsletterSubscriptionHidden(
      request: NewsletterSubscriptionSetHiddenRequest,
    ): Promise<NewsletterSubscriptionActionDto> {
      return invokeCommand<NewsletterSubscriptionActionDto>(
        "newsletter_subscription_set_hidden",
        { request },
      );
    },
  };
}
