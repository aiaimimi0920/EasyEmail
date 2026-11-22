import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { identityCredentialFence } from "./identity";
import { inboxAccountFence, type InboxClaim, type InboxState } from "./normal-inbox-claim";
import { folderInboxMembership, type FolderInboxTarget, type ReceiveFence } from "./normal-folder-inbox-target";

export async function claimFolderInbox(env: Env, identity: Identity, target: FolderInboxTarget, requestId: string): Promise<InboxClaim> {
  const account = target.account, token = crypto.randomUUID(), membership = folderInboxMembership(target);
  const guard: ReceiveFence = { sql: `${membership.sql} AND ${identityCredentialFence(identity)}`,
    values: [...membership.values, identity.credentialId, identity.userId] };
  const accountValues = [account.id, identity.userId, account.revision];
  const result = await env.DB.batch([
    env.DB.prepare(`INSERT INTO normal_server_folder_state(account_id,server_folder_id,wire_name)
      SELECT ?,?,? WHERE ${inboxAccountFence} AND ${guard.sql}
      AND (SELECT COUNT(*) FROM normal_server_folder_state WHERE account_id=?)<256 ON CONFLICT(account_id,server_folder_id) DO NOTHING`)
      .bind(account.id, target.id, target.wireName, ...accountValues, ...guard.values, account.id),
    env.DB.prepare(`UPDATE normal_server_folder_state SET claim_token=?,claim_revision=?,request_id=?,claim_lease_until=unixepoch()+90
      WHERE account_id=? AND server_folder_id=? AND wire_name=? AND (claim_token IS NULL OR claim_lease_until<=unixepoch() OR claim_revision<>?)
      AND ${inboxAccountFence} AND ${guard.sql}`)
      .bind(token, account.revision, requestId, account.id, target.id, target.wireName, account.revision, ...accountValues, ...guard.values),
  ]);
  if (!result[1].meta.changes) throw new HttpError(409, "normal_folder_inbox_busy_changed_or_limit");
  const state = await env.DB.prepare("SELECT * FROM normal_server_folder_state WHERE account_id=? AND server_folder_id=? AND claim_token=?")
    .bind(account.id, target.id, token).first<InboxState>();
  if (!state) throw new HttpError(409, "normal_inbox_changed");
  const same = state.source_hash === target.sourceHash;
  return { accountId: account.id, userId: identity.userId, revision: account.revision, sourceHash: target.sourceHash, token,
    version: state.version, requestId, epochId: same ? state.epoch_id : null,
    cursor: same && state.uid_validity ? { uidValidity: state.uid_validity, afterUid: state.after_uid } : null,
    serverFolder: target, receiveFence: guard };
}
export async function releaseFolderInbox(env: Env, claim: InboxClaim) {
  await env.DB.prepare(`UPDATE normal_server_folder_state SET claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL,request_id=NULL
    WHERE account_id=? AND server_folder_id=? AND claim_token=?`).bind(claim.accountId, claim.serverFolder!.id, claim.token).run();
}
