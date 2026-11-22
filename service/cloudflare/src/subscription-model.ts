export interface SubscriptionHeaders {
  listId: string; unsubscribe: string; unsubscribePost: string; precedence: string; listPost: string; listHelp: string; feedbackId: string; limited: boolean;
}
export interface SubscriptionPlan { key: string | null; listId: string; name: string; sender: string; methods: string[]; limited: boolean }
export interface SubscriptionOperation {
  id: string; request_key: string; request_hash: string; mailbox_id: string; subscription_key: string; hidden: number; version: number | null; completed_at: number | null;
}
