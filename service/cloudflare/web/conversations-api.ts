import type { MessageSummary } from "./api";
import type { NormalAggregateSummary } from "./normal-inbox";

interface ConversationStats {
  id: string; basis: "headers" | "subject" | "single"; limited: boolean;
  messageCount: number; unreadCount: number; starred: boolean;
}
export type Conversation = ConversationStats & ({ sourceKind?: "temporary"; mailboxId: string; latest: MessageSummary }
  | { sourceKind: "normal"; accountId: string; epochId: string; latest: NormalAggregateSummary });
export const conversationKey = (item: Conversation) => item.sourceKind === "normal"
  ? `normal:${item.accountId}:${item.epochId}:${item.id}` : `temporary:${item.mailboxId}:${item.id}`;
export function conversationMemberQuery(item: Conversation, query: string) {
  const params = new URLSearchParams(query);
  if (item.sourceKind === "normal") { params.set("sources", "normal"); params.set("accountId", item.accountId); }
  else { params.delete("accountId"); if (params.has("sources")) params.set("sources", "temporary"); }
  return params.toString();
}
