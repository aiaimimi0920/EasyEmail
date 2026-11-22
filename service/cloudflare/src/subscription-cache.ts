import type { Env } from "./contracts";
import type { ThreadTarget } from "./message-thread-store";
import type { SubscriptionPlan } from "./subscription-model";

export function subscriptionWriteStatements(env: Env, userId: string, mailboxId: string, target: ThreadTarget, plan: SubscriptionPlan | null) {
  if (!plan) return [];
  return [env.DB.prepare(`INSERT INTO message_subscriptions(user_id,mailbox_id,message_id,subscription_key,list_id,display_name,sender_address,unsubscribe_methods,limited)
    SELECT ?,?,m.id,?,?,?,?,?,? FROM messages m WHERE ${target.where} AND m.purged_at IS NULL
    ON CONFLICT(user_id,mailbox_id,message_id) DO NOTHING`)
    .bind(userId, mailboxId, plan.key, plan.listId, plan.name, plan.sender, JSON.stringify(plan.methods), Number(plan.limited), ...target.values)];
}
