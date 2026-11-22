import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { NormalMimeContent } from "./normal-mime-content";
import { parseSubscriptionHeaders, subscriptionPlan } from "./subscription-input";
import type { ThreadTarget } from "./thread-graph-store";

export async function normalSubscriptionPlan(content: NormalMimeContent) {
  const headers = content.subscriptionHeaders;
  if (headers === undefined) return null;
  if (!headers || typeof headers !== "object" || Array.isArray(headers) || typeof headers.limited !== "boolean"
    || [headers.listId, headers.unsubscribe, headers.unsubscribePost, headers.precedence, headers.listPost, headers.listHelp, headers.feedbackId]
      .some(value => typeof value !== "string" || value.length > 8192 || /[\p{Cc}\p{Cf}]/u.test(value.replace(/\t/g, "")))) {
    throw new HttpError(503, "normal_content_unavailable");
  }
  return subscriptionPlan(content.sender, parseSubscriptionHeaders({ ...headers, version: 1 }));
}
export async function normalSubscriptionStatements(env: Env, userId: string, accountId: string, epochId: string, target: ThreadTarget, content: NormalMimeContent) {
  const plan = await normalSubscriptionPlan(content);
  return [env.DB.prepare(`INSERT INTO normal_message_subscriptions
    (user_id,account_id,epoch_id,message_id,subscription_key,list_id,display_name,sender_address,unsubscribe_methods,limited,evidence_present)
    SELECT ?,?,?,m.id,?,?,?,?,?,?,? FROM normal_inbox_messages m WHERE m.account_id=? AND m.epoch_id=? AND ${target.where}
    ON CONFLICT(user_id,account_id,epoch_id,message_id) DO NOTHING`)
    .bind(userId, accountId, epochId, plan?.key ?? null, plan?.listId ?? "", plan?.name ?? "", plan?.sender ?? "",
      JSON.stringify(plan?.methods ?? []), Number(plan?.limited ?? false), Number(plan !== null), accountId, epochId, ...target.values)];
}
