import type { MessageSummary } from "./api";
import type { NormalAggregateSummary } from "./normal-inbox";

interface SubscriptionBase {
  id: string; name: string; listId: string; senderAddress: string;
  hidden: boolean; version: number; messageCount: number; unreadCount: number; limited: boolean;
  methods: string[];
}
export type Subscription = SubscriptionBase & ({ sourceKind?: "temporary"; mailboxId: string; latest: MessageSummary }
  | { sourceKind: "normal"; accountId: string; epochId: string; latest: NormalAggregateSummary });
export interface SubscriptionAttempt {
  key: string; path: string; receiptPath: string; body: { expectedVersion: number; hidden: boolean; expectedEpochId?: string };
}
export const subscriptionPath = (item: Subscription) => item.sourceKind === "normal" ? `/normal-subscriptions/${item.accountId}/${item.id}` : `/subscriptions/${item.mailboxId}/${item.id}`;
export const subscriptionIdentity = (item: Subscription) => item.sourceKind === "normal" ? `normal:${item.accountId}:${item.epochId}:${item.id}` : `temporary:${item.mailboxId}:${item.id}`;
export function subscriptionMembersPath(item: Subscription, query: string) {
  const params = new URLSearchParams(query); params.delete("sources"); params.delete("accountId");
  if (item.sourceKind === "normal") params.set("epochId", item.epochId);
  return `${subscriptionPath(item)}/messages?${params}`;
}
