import type {
  EasyEmailListNewsletterSubscriptionsQuery,
  EasyEmailListNewsletterSubscriptionsResponse,
  EasyEmailNewsletterSubscription,
  EasyEmailUpdateNewsletterSubscriptionRequest,
  EasyEmailUpdateNewsletterSubscriptionResponse,
} from "./easyEmailHttpClient.ts";

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

export interface NewsletterHttpTransport {
  listNewsletterSubscriptions(
    query: EasyEmailListNewsletterSubscriptionsQuery,
  ): Promise<EasyEmailListNewsletterSubscriptionsResponse>;
  setNewsletterSubscriptionHidden(
    subscriptionId: string,
    request: EasyEmailUpdateNewsletterSubscriptionRequest,
  ): Promise<EasyEmailUpdateNewsletterSubscriptionResponse>;
}

function toNewsletterSubscriptionDto(
  sub: EasyEmailNewsletterSubscription,
): NewsletterSubscriptionDto {
  return {
    id: sub.id,
    list_id: sub.listId,
    sender_address: sub.senderAddress,
    name: sub.name,
    received_message_count: sub.receivedMessageCount,
    unread_message_count: sub.unreadMessageCount,
    last_received_at: sub.lastReceivedAt,
    unsubscribe_methods: [...sub.unsubscribeMethods],
    spam: sub.spam,
    hidden: sub.hidden,
  };
}

export function createNewsletterClient(transport: NewsletterHttpTransport) {
  return {
    async listNewsletterSubscriptions(
      request: NewsletterSubscriptionListRequest,
    ): Promise<NewsletterSubscriptionDto[]> {
      const response = await transport.listNewsletterSubscriptions({
        accountId: request.account_id,
      });
      return response.subscriptions.map(toNewsletterSubscriptionDto);
    },
    async setNewsletterSubscriptionHidden(
      request: NewsletterSubscriptionSetHiddenRequest,
    ): Promise<NewsletterSubscriptionActionDto> {
      const response = await transport.setNewsletterSubscriptionHidden(
        request.subscription_id,
        {
          accountId: request.account_id,
          hidden: request.hidden,
        },
      );
      return {
        account_id: response.action.accountId,
        subscription_id: response.action.subscriptionId,
        hidden: response.action.hidden,
        changed: response.action.changed,
      };
    },
  };
}
