import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError } from "./http";
import { credentialRequestHash } from "./mailbox-vault";
import { googleTargets, googleAccountStatements, type GoogleTarget } from "./google-oauth-target";
import { attemptContext, googleSessionSql, googleSessionValues } from "./google-oauth-model";

interface Disconnect { id: string; account_id: string; request_hash: string; revision: number }
// Deliberately local-only: a late remote revoke could invalidate a newer Google authorization.
// The response never claims that Google permissions have been revoked.
export async function disconnectGoogleOAuth(env: Env, identity: Identity, accountId: string, revision: number, key: string, target: GoogleTarget = googleTargets.normal) {
  const context = attemptContext(accountId, identity.userId, target.scope), payload = JSON.stringify(["disconnect", accountId, revision]);
  const lookup = () => env.DB.prepare(`SELECT * FROM ${target.disconnects} WHERE user_id=? AND request_key=?`).bind(identity.userId, key).first<Disconnect>();
  async function result(row: Disconnect, replayed: boolean) {
    if (await credentialRequestHash(env, context, payload, row.request_hash) !== row.request_hash) throw new HttpError(409, "idempotency_conflict");
    const account = await target.account(env, identity.userId, row.account_id); if (!account) throw new HttpError(404, "not_found");
    return { account: target.view(account), operationRevision: row.revision, remoteRevocation: "not_requested", replayed };
  }
  const old = await lookup(); if (old) return result(old, true);
  const id = crypto.randomUUID(), now = unixNow(), digest = await credentialRequestHash(env, context, payload);
  const owned = `EXISTS (SELECT 1 FROM ${target.disconnects} WHERE id=?)`;
  const capacity = target.scope === "normal" ? `AND (SELECT COUNT(*) FROM ${target.disconnects} WHERE user_id=?)<10000` : "";
  const writes = await env.DB.batch([
    env.DB.prepare(`INSERT INTO ${target.disconnects}(id,user_id,account_id,request_key,request_hash,revision,created_at)
      SELECT ?,?,?,?,?,?,? WHERE ${googleSessionSql} AND EXISTS (SELECT 1 FROM ${target.accounts} WHERE id=? AND user_id=? AND revision=? AND deleted_at IS NULL AND authentication='google-oauth2')
      ${capacity} ON CONFLICT(user_id,request_key) DO NOTHING`)
      .bind(id, identity.userId, accountId, key, digest, Math.min(revision + 1, Number.MAX_SAFE_INTEGER), now, ...googleSessionValues(identity), accountId, identity.userId, revision, ...(capacity ? [identity.userId] : [])),
    ...googleAccountStatements(env, target, { id: accountId, user_id: identity.userId }, null, null, now, owned, id),
    env.DB.prepare(`UPDATE ${target.grants} SET state='disconnected',secret_cipher=NULL,version=version+1,refresh_claim=NULL,refresh_until=NULL,updated_at=?
      WHERE user_id=? AND account_id=? AND ${owned}`).bind(now, identity.userId, accountId, id),
    env.DB.prepare(`UPDATE ${target.attempts} SET state='failed',secret_cipher=NULL,error_code='google_oauth_disconnected'
      WHERE user_id=? AND account_id=? AND state IN ('pending','exchanging') AND ${owned}`).bind(identity.userId, accountId, id),
    env.DB.prepare(`UPDATE ${target.smtp} SET enabled=0,credential_cipher=NULL,revision=${target.scope === "agent" ? "MIN(revision+1,9007199254740991)" : "revision+1"},updated_at=? WHERE user_id=? AND account_id=? AND ${owned}`)
      .bind(now, identity.userId, accountId, id),
  ]);
  const receipt = await lookup(); if (!receipt) throw new HttpError(409, target.changed);
  return result(receipt, !writes[0].meta.changes);
}
