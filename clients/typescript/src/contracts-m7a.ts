import type { MailAccount } from "./contracts-catalog.js";
import type { MailboxSession } from "./contracts-mailbox.js";

export interface PromoteMailboxSessionInput {
  confirmLifecycleAck: boolean;
  displayName?: string | null;
}

export interface PromoteMailboxSessionResult {
  account: MailAccount;
  session: MailboxSession;
  linkedMessageCount: number;
}

export interface MailNewsletterSubscription {
  id: string;
  listId: string;
  senderAddress: string;
  name: string;
  receivedMessageCount: number;
  unreadMessageCount: number;
  lastReceivedAt: string;
  unsubscribeMethods: string[];
  spam: boolean;
  hidden: boolean;
}

export interface MailNewsletterSubscriptionListQuery {
  accountId: string;
}

export interface ListNewsletterSubscriptionsResult {
  subscriptions: MailNewsletterSubscription[];
}

export interface MailNewsletterSubscriptionUpdateInput {
  accountId: string;
  hidden: boolean;
}

export interface MailNewsletterSubscriptionActionResult {
  accountId: string;
  subscriptionId: string;
  hidden: boolean;
  changed: boolean;
}

export interface EasyEmailClientSettings {
  serviceUrl: string | null;
  hasApiToken: boolean;
}

export interface EasyEmailClientSettingsUpdateInput {
  serviceUrl: string;
}

export interface EasyEmailConnectionTestInput {
  serviceUrl?: string | null;
  apiToken?: string | null;
}

export interface EasyEmailConnectionHealth {
  reachable: boolean;
  providerCount: number;
  authStatus: string;
  capabilitiesSummary: string;
}
