import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { identityCredentialFence, requireScope } from "./identity";
import { inboxAccountFence } from "./normal-inbox-claim";
import type { NormalAccount } from "./normal-account-model";
import type { ImapFolder } from "./normal-imap-folders";
import { tokenHash } from "./security";

interface CatalogRow {
  account_id: string; source_hash: string | null; snapshot_id: string | null; snapshot_revision: number | null;
  folders: string | null; observed_at: number | null;
}
export const serverFolderSource = (account: NormalAccount) => tokenHash(JSON.stringify([
  "normal-server-folders-v1", account.endpoint_hash, account.username, account.email_address,
]));
export async function serverFolderAccount(env: Env, identity: Identity, id: string) {
  requireScope(identity, "mail-accounts:read"); requireScope(identity, "messages:read");
  const account = await env.DB.prepare(`SELECT a.* FROM normal_accounts a JOIN users u ON u.id=a.user_id
    WHERE a.id=? AND a.user_id=? AND a.deleted_at IS NULL AND u.status='active'`).bind(id, identity.userId).first<NormalAccount>();
  if (!account) throw new HttpError(404, "not_found"); return account;
}
export async function readServerFolders(env: Env, identity: Identity, id: string) {
  const account = await serverFolderAccount(env, identity, id), source = await serverFolderSource(account);
  const row = await env.DB.prepare("SELECT * FROM normal_server_folder_catalogs WHERE account_id=?").bind(id).first<CatalogRow>();
  if ((await serverFolderAccount(env, identity, id)).revision !== account.revision) throw new HttpError(409, "normal_account_changed");
  const current = !!row?.snapshot_id && row.source_hash === source;
  return { accountId: id, accountRevision: account.revision, current, complete: current,
    snapshotId: current ? row!.snapshot_id : null, snapshotAccountRevision: current ? row!.snapshot_revision : null,
    observedAt: current ? row!.observed_at : null, items: current ? JSON.parse(row!.folders!) as (ImapFolder & { id: string })[] : [] };
}
export async function claimServerFolders(env: Env, identity: Identity, account: NormalAccount, token: string) {
  const values = [account.id, identity.userId, account.revision];
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO normal_server_folder_catalogs(account_id) SELECT ? WHERE ${inboxAccountFence}
      ON CONFLICT(account_id) DO NOTHING`).bind(account.id, ...values),
    env.DB.prepare(`UPDATE normal_server_folder_catalogs SET claim_token=?,claim_revision=?,claim_lease_until=unixepoch()+45
      WHERE account_id=? AND (claim_token IS NULL OR claim_lease_until<=unixepoch() OR claim_revision<>?)
      AND ${inboxAccountFence} AND ${identityCredentialFence(identity)}`)
      .bind(token, account.revision, account.id, account.revision, ...values, identity.credentialId, identity.userId),
  ]);
  if (!results[1].meta.changes) throw new HttpError(409, "normal_folder_discovery_busy_or_changed");
}
const claimFence = `account_id=? AND claim_token=? AND claim_revision=? AND claim_lease_until>unixepoch()`;
export async function assertServerFolderClaim(env: Env, identity: Identity, account: NormalAccount, token: string, authentication: { sql: string; values: (string | number)[] }) {
  const valid = await env.DB.prepare(`SELECT 1 ok FROM normal_server_folder_catalogs WHERE ${claimFence}
    AND ${inboxAccountFence} AND ${identityCredentialFence(identity)} AND ${authentication.sql}`)
    .bind(account.id, token, account.revision, account.id, identity.userId, account.revision, identity.credentialId, identity.userId, ...authentication.values).first();
  if (!valid) throw new HttpError(409, "normal_folder_discovery_changed");
}
export async function publishServerFolders(env: Env, identity: Identity, account: NormalAccount, token: string,
  folders: ImapFolder[], authentication: { sql: string; values: (string | number)[] }) {
  const source = await serverFolderSource(account);
  const items = await Promise.all(folders.map(async folder => ({ ...folder, id: await tokenHash(JSON.stringify(["normal-server-folder-v1", account.id, source, folder.wireName])) })));
  const json = JSON.stringify(items);
  if (new TextEncoder().encode(json).byteLength > 512 * 1024) throw new HttpError(502, "imap_folder_catalog_limit");
  const stored = await env.DB.prepare(`UPDATE normal_server_folder_catalogs SET source_hash=?,snapshot_id=?,snapshot_revision=?,folders=?,observed_at=unixepoch(),
    claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL WHERE ${claimFence}
    AND ${inboxAccountFence} AND ${identityCredentialFence(identity)} AND ${authentication.sql}`)
    .bind(source, token, account.revision, json, account.id, token, account.revision, account.id, identity.userId, account.revision,
      identity.credentialId, identity.userId, ...authentication.values).run();
  if (!stored.meta.changes) throw new HttpError(409, "normal_folder_discovery_changed");
}
export async function releaseServerFolders(env: Env, id: string, token: string) {
  await env.DB.prepare(`UPDATE normal_server_folder_catalogs SET claim_token=NULL,claim_revision=NULL,claim_lease_until=NULL
    WHERE account_id=? AND claim_token=?`).bind(id, token).run();
}
