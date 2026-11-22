import type { MailAccount } from "./account.js";
import type { MailboxSession } from "./models.js";

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

export interface MailExtensionsRepository {
  listNewsletterSubscriptions(accountId: string): Promise<MailNewsletterSubscription[]>;
  setNewsletterSubscriptionHidden(
    accountId: string,
    subscriptionId: string,
    hidden: boolean,
    now: string,
  ): Promise<boolean>;
  getClientSetting(settingKey: string): Promise<string | undefined>;
  setClientSetting(settingKey: string, settingValue: string | null, now: string): Promise<void>;
}

export function normalizeNewsletterListId(rawListId?: string | null): string {
  if (!rawListId) return "";
  const trimmed = rawListId.trim();
  const angleMatch = trimmed.match(/<([^>]+)>/u);
  const extracted = (angleMatch?.[1] ?? trimmed).trim().toLowerCase();
  return extracted.slice(0, 320);
}

export function computeNewsletterSubscriptionId(
  rawListId?: string | null,
  senderAddress?: string | null,
): string | undefined {
  const listId = normalizeNewsletterListId(rawListId);
  if (listId) {
    return `list:${listId}`;
  }
  const sender = senderAddress?.trim().toLowerCase() ?? "";
  if (sender) {
    return `sender:${sender}`;
  }
  return undefined;
}

export function parseUnsubscribeHeaderMethods(rawHeader?: string | null): string[] {
  if (!rawHeader) return [];
  const methods: string[] = [];
  const seen = new Set<string>();
  const bracketMatches = rawHeader.matchAll(/<([^>]+)>/gu);
  for (const match of bracketMatches) {
    const candidate = (match[1] ?? "").trim();
    if (!candidate) continue;
    if (!/^(?:https?:|mailto:)/iu.test(candidate)) continue;
    const key = candidate.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      methods.push(candidate);
    }
  }
  return methods;
}

export function deriveNewsletterDisplayName(
  fromName: string | null | undefined,
  listId: string,
  senderAddress: string,
): string {
  const cleanFromName = fromName?.trim();
  if (cleanFromName) return cleanFromName;
  if (listId) {
    const firstLabel = listId.split(".")[0]?.replace(/[-_]+/gu, " ").trim();
    if (firstLabel) return firstLabel;
  }
  const atIndex = senderAddress.indexOf("@");
  if (atIndex > 0) {
    return senderAddress.slice(0, atIndex);
  }
  return senderAddress || "Newsletter";
}
