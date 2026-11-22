import type { Env } from "./contracts";
import { HttpError } from "./http";
import type { NormalAccount } from "./normal-account-model";
import type { ImapCursor } from "./normal-imap-read";
import { tokenHash } from "./security";
import type { FolderInboxTarget, ReceiveFence } from "./normal-folder-inbox-target";

export const normalInboxSourceHash = (account: NormalAccount) => tokenHash(JSON.stringify([
  "normal-inbox-v1", account.endpoint_hash, account.username, account.email_address, "INBOX",
]));

export interface InboxState {
  account_id: string; source_hash: string | null; epoch_id: string | null; uid_validity: string | null;
  after_uid: number; version: number; claim_token: string | null; claim_revision: number | null; cache_generation: number;
}
export interface InboxClaim {
  accountId: string; userId: string; revision: number; sourceHash: string; token: string;
  version: number; epochId: string | null; cursor: ImapCursor | null;
  requestId?: string;
  serverFolder?: FolderInboxTarget; receiveFence?: ReceiveFence;
}
export const inboxAccountFence = `EXISTS (SELECT 1 FROM normal_accounts a JOIN users u ON u.id=a.user_id
  WHERE a.id=? AND a.user_id=? AND a.revision=? AND a.enabled=1 AND a.deleted_at IS NULL AND u.status='active')`;
export const inboxClaimFence = `EXISTS (SELECT 1 FROM normal_inbox_state s WHERE s.account_id=? AND s.version=?
  AND s.claim_token=? AND s.claim_revision=? AND s.claim_lease_until>unixepoch()) AND ${inboxAccountFence}`;
export const receiveStateTable = (claim: InboxClaim) => claim.serverFolder ? "normal_server_folder_state" : "normal_inbox_state";
export const receiveClaimFence = (claim: InboxClaim) => `EXISTS (SELECT 1 FROM ${receiveStateTable(claim)} s WHERE s.account_id=? AND s.version=?
  AND s.claim_token=? AND s.claim_revision=? AND s.claim_lease_until>unixepoch()${claim.serverFolder ? " AND s.server_folder_id=?" : ""})
  AND ${inboxAccountFence}${claim.receiveFence ? ` AND ${claim.receiveFence.sql}` : ""}`;
export const claimValues = (claim: InboxClaim) => [claim.accountId, claim.version, claim.token, claim.revision,
  ...(claim.serverFolder ? [claim.serverFolder.id] : []), claim.accountId, claim.userId, claim.revision, ...(claim.receiveFence?.values ?? [])];

export async function claimNormalInbox(env: Env, account: NormalAccount, sourceHash: string, requestId?: string): Promise<InboxClaim> {
  const token = crypto.randomUUID(), values = [account.id, account.user_id, account.revision];
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO normal_inbox_state(account_id) SELECT ? WHERE ${inboxAccountFence}
      ON CONFLICT(account_id) DO NOTHING`).bind(account.id, ...values),
    env.DB.prepare(`UPDATE normal_inbox_state SET claim_token=?,claim_revision=?,request_id=?,claim_lease_until=unixepoch()+90
      WHERE account_id=? AND (claim_token IS NULL OR claim_lease_until<=unixepoch() OR claim_revision<>?) AND ${inboxAccountFence}`)
      .bind(token, account.revision, requestId ?? null, account.id, account.revision, ...values),
  ]);
  if (!results[1].meta.changes) throw new HttpError(409, "normal_inbox_busy_or_changed");
  const state = await env.DB.prepare("SELECT * FROM normal_inbox_state WHERE account_id=? AND claim_token=?")
    .bind(account.id, token).first<InboxState>();
  if (!state) throw new HttpError(409, "normal_inbox_changed");
  const sameSource = state.source_hash === sourceHash;
  return { accountId: account.id, userId: account.user_id, revision: account.revision, sourceHash, token,
    version: state.version, requestId, epochId: sameSource ? state.epoch_id : null,
    cursor: sameSource && state.uid_validity ? { uidValidity: state.uid_validity, afterUid: state.after_uid } : null };
}
export async function releaseNormalInbox(env: Env, claim: InboxClaim) {
  await env.DB.prepare(`UPDATE normal_inbox_state SET claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL
    WHERE account_id=? AND claim_token=?`).bind(claim.accountId, claim.token).run();
}
