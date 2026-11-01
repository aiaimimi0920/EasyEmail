import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { tokenHash } from "./security";
import type { SubscriptionOperation } from "./subscription-model";
import { subscriptionPreferenceStatements } from "./subscription-preference-store";

export const subscriptionOperation = (env: Env, userId: string, key: string) => env.DB.prepare("SELECT * FROM subscription_operations WHERE user_id=? AND request_key=?")
  .bind(userId, key).first<SubscriptionOperation>();
export function subscriptionOperationView(row: SubscriptionOperation) {
  if (row.completed_at === null || row.version === null) throw new HttpError(503, "subscription_storage_failed");
  return { id: row.id, requestKey: row.request_key, mailboxId: row.mailbox_id, subscriptionId: row.subscription_key, hidden: row.hidden === 1, version: row.version };
}
export async function setSubscriptionHidden(env: Env, identity: Identity, requestKey: string, mailboxId: string, key: string, expectedVersion: number, hidden: boolean) {
  const hash = await tokenHash(JSON.stringify([mailboxId, key, expectedVersion, hidden]));
  const replay = (row: SubscriptionOperation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: subscriptionOperationView(row), replayed: true };
  };
  const previous = await subscriptionOperation(env, identity.userId, requestKey);
  if (previous) return replay(previous);
  const exists = `EXISTS(SELECT 1 FROM message_subscriptions s JOIN messages m ON m.user_id=s.user_id AND m.mailbox_id=s.mailbox_id AND m.id=s.message_id
    JOIN mailboxes b ON b.id=m.mailbox_id AND b.user_id=m.user_id WHERE s.user_id=? AND s.mailbox_id=? AND s.subscription_key=? AND m.purged_at IS NULL AND m.trashed_at IS NULL)`;
  const id = crypto.randomUUID(), now = unixNow(), owner = [identity.userId, mailboxId, key];
  let writes: D1Result[];
  try { writes = await env.DB.batch(subscriptionPreferenceStatements(env, {
    preferences: "subscription_preferences", operations: "subscription_operations", owner: { user_id: identity.userId, mailbox_id: mailboxId, subscription_key: key },
    exists, existsValues: owner, requestKey, hash, id, now, expectedVersion, hidden,
  })); } catch { throw new HttpError(503, "subscription_storage_failed"); }
  const row = await subscriptionOperation(env, identity.userId, requestKey);
  if (row) return writes[0].meta.changes ? { operation: subscriptionOperationView(row), replayed: false } : replay(row);
  if (!await env.DB.prepare(`SELECT 1 WHERE ${exists}`).bind(...owner).first()) throw new HttpError(404, "not_found");
  throw new HttpError(409, "subscription_changed");
}
