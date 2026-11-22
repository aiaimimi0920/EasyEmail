import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import type { NormalAccount } from "./normal-account-model";
import { normalInboxSourceHash } from "./normal-inbox-claim";
import type { InboxState } from "./normal-inbox-claim";
import { normalStateColumns, normalStateJoin, type NormalPlatformColumns } from "./normal-message-state";
import type { FolderInboxTarget } from "./normal-folder-inbox-target";

export interface NormalInboxContext {
  account: NormalAccount; epochId: string | null; afterUid: number; cacheGeneration: number;
  serverFolder?: FolderInboxTarget;
}
export interface NormalStoredMessage extends NormalPlatformColumns {
  id: string; account_id: string; epoch_id: string; uid_validity: string; uid: number; raw_key: string; content_key: string;
  raw_sha256: string; content_sha256: string; raw_bytes: number; content_bytes: number;
  received_at: number; observed_at: number; flags: string; summary: string | null;
}
export async function normalInboxContext(env: Env, identity: Identity, accountId: string): Promise<NormalInboxContext> {
  requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
  const account = await env.DB.prepare(`SELECT a.* FROM normal_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND a.deleted_at IS NULL AND u.status='active'`).bind(accountId, identity.userId).first<NormalAccount>();
  if (!account) throw new HttpError(404, "not_found");
  const state = await env.DB.prepare("SELECT * FROM normal_inbox_state WHERE account_id=?").bind(accountId).first<InboxState>();
  const current = state?.source_hash === await normalInboxSourceHash(account);
  return { account, epochId: current ? state!.epoch_id : null, afterUid: current ? state!.after_uid : 0, cacheGeneration: state?.cache_generation ?? 0 };
}
export async function assertNormalInboxCurrent(env: Env, identity: Identity, context: NormalInboxContext) {
  const actual = await normalInboxContext(env, identity, context.account.id);
  if (actual.account.revision !== context.account.revision || actual.epochId !== context.epochId || actual.cacheGeneration !== context.cacheGeneration) throw new HttpError(409, "normal_account_changed");
}
export async function normalStoredMessage(env: Env, context: NormalInboxContext, id: string) {
  if (!context.epochId) throw new HttpError(404, "not_found");
  const row = await env.DB.prepare(`SELECT m.*,${normalStateColumns} FROM normal_inbox_messages m JOIN normal_inbox_batches b ON b.id=m.batch_id ${normalStateJoin}
    WHERE m.id=? AND m.account_id=? AND m.epoch_id=? AND m.purged_at IS NULL AND b.status='committed'
    AND b.account_id=m.account_id AND b.epoch_id=m.epoch_id AND b.source_hash=?`).bind(id, context.account.id, context.epochId,
      await normalInboxSourceHash(context.account)).first<NormalStoredMessage>();
  if (!row) throw new HttpError(404, "not_found"); return row;
}
