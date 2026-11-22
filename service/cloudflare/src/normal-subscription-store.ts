import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { normalSearchContexts, normalSearchJoin, normalSearchVisible } from "./normal-search-index";
import { identityCredentialFence, requireScope } from "./identity";
import { tokenHash } from "./security";
import { subscriptionPreferenceStatements } from "./subscription-preference-store";

interface Operation {
  id: string; request_key: string; request_hash: string; account_id: string; account_revision: number; epoch_id: string;
  subscription_key: string; hidden: number; version: number | null; completed_at: number | null;
}
export const normalSubscriptionOperation = (env: Env, identity: Identity, key: string) => env.DB.prepare(`SELECT o.*
  FROM normal_subscription_operations o JOIN normal_accounts a ON a.id=o.account_id JOIN users u ON u.id=a.user_id
  WHERE o.user_id=? AND o.request_key=? AND a.user_id=o.user_id AND a.deleted_at IS NULL AND u.status='active'`)
  .bind(identity.userId, key).first<Operation>();
export function normalSubscriptionOperationView(row: Operation) {
  if (row.completed_at === null || row.version === null) throw new HttpError(503, "normal_subscription_storage_failed");
  return { id: row.id, requestKey: row.request_key, sourceKind: "normal", accountId: row.account_id, accountRevision: row.account_revision,
    epochId: row.epoch_id, subscriptionId: row.subscription_key, hidden: row.hidden === 1, version: row.version };
}
export async function setNormalSubscriptionHidden(env: Env, identity: Identity, requestKey: string, accountId: string, key: string, epochId: string, expectedVersion: number, hidden: boolean) {
  const hash = await tokenHash(JSON.stringify(["normal-subscription-v1", accountId, epochId, key, expectedVersion, hidden]));
  const replay = (row: Operation) => {
    if (row.request_hash !== hash) throw new HttpError(409, "idempotency_conflict");
    return { operation: normalSubscriptionOperationView(row), replayed: true };
  };
  const previous = await normalSubscriptionOperation(env, identity, requestKey); if (previous) return replay(previous);
  requireScope(identity, "messages:read");
  const contexts = (await normalSearchContexts(env, identity, accountId)).filter(context => context.epochId === epochId), context = contexts[0];
  if (!context) throw new HttpError(409, "normal_account_changed");
  const exists = `EXISTS(SELECT 1 FROM normal_inbox_messages m ${normalSearchJoin(contexts)}
    JOIN normal_message_subscriptions ns ON ns.user_id=a.user_id AND ns.account_id=m.account_id AND ns.epoch_id=m.epoch_id AND ns.message_id=m.id
    LEFT JOIN normal_message_state ps ON ps.message_id=m.id WHERE ${normalSearchVisible} AND ns.subscription_key=? AND ps.trashed_at IS NULL)
    AND ${identityCredentialFence(identity)}`;
  const existsValues = [JSON.stringify(contexts), identity.userId, key, identity.credentialId, identity.userId];
  const capacity = "(SELECT COUNT(*) FROM normal_subscription_operations WHERE user_id=? AND account_id=?)<10000";
  const id = crypto.randomUUID(); let changed;
  try {
    changed = !!(await env.DB.batch(subscriptionPreferenceStatements(env, {
      preferences: "normal_subscription_preferences", operations: "normal_subscription_operations",
      owner: { user_id: identity.userId, account_id: accountId, epoch_id: epochId, subscription_key: key }, metadata: { account_revision: context.revision },
      exists: `${exists} AND ${capacity}`, existsValues: [...existsValues, identity.userId, accountId],
      requestKey, hash, id, now: unixNow(), expectedVersion, hidden,
    })))[0].meta.changes;
  } catch {
    const known = await normalSubscriptionOperation(env, identity, requestKey);
    if (known && known.completed_at !== null) return replay(known);
    throw new HttpError(503, "normal_subscription_storage_failed");
  }
  const row = await normalSubscriptionOperation(env, identity, requestKey);
  if (row) return changed ? { operation: normalSubscriptionOperationView(row), replayed: false } : replay(row);
  if (!await env.DB.prepare(`SELECT 1 WHERE ${exists}`).bind(...existsValues).first()) throw new HttpError(409, "normal_account_changed");
  throw new HttpError(409, "normal_subscription_changed_or_limit");
}
