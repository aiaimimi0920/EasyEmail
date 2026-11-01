import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { imapEndpoint, normalRevision } from "./normal-account-input";
import { normalAccount, normalContext } from "./normal-account-store";
import { normalAccountView } from "./normal-account-model";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { rateLimit } from "./rate-limits";
import { testImapConnection } from "./normal-imap-client";

export async function testNormalAccount(request: Request, env: Env, identity: Identity, id: string) {
  const body = await readJson(request), revision = normalRevision(body);
  if (Object.keys(body).some(key => key !== "expectedRevision")) throw new HttpError(400, "invalid_normal_account_request");
  const row = await normalAccount(env, identity.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  if (row.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!row.enabled) throw new HttpError(409, "normal_account_disabled");
  const endpoint = await imapEndpoint(env, row.endpoint_id);
  if (endpoint.hash !== row.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "normal-account-test", identity.userId, 5);
  await rateLimit(env, "normal-account-test-global", "platform", 30);
  const token = crypto.randomUUID();
  const acquired = await env.DB.prepare(`UPDATE normal_accounts SET test_token=?,test_lease_until=unixepoch()+45 WHERE id=? AND user_id=?
    AND revision=? AND enabled=1 AND deleted_at IS NULL AND (test_lease_until IS NULL OR test_lease_until<=unixepoch())
    AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')`).bind(token, id, identity.userId, revision, identity.userId).run();
  if (!acquired.meta.changes) throw new HttpError(409, "normal_account_busy_or_changed");
  try {
    const credential = await normalMailAuthentication(env, row, row.credential_cipher, normalContext(id, identity.userId), endpoint, row.username);
    const result = await testImapConnection(endpoint, row.username, credential.authentication);
    const stored = await env.DB.prepare(`UPDATE normal_accounts SET tested_at=?,test_error=NULL,inbox_uid_validity=?,inbox_messages=?,test_token=NULL,test_lease_until=NULL
      WHERE id=? AND user_id=? AND revision=? AND test_token=? AND test_lease_until>unixepoch() AND enabled=1 AND deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM users WHERE id=? AND status='active')`)
      .bind(unixNow(), result.inbox.uidValidity, result.inbox.messages, id, identity.userId, revision, token, identity.userId).run();
    if (!stored.meta.changes) throw new HttpError(409, "normal_account_changed");
    const current = await normalAccount(env, identity.userId, id);
    if (!current || current.revision !== revision || !current.enabled || current.deleted_at !== null) throw new HttpError(409, "normal_account_changed");
    return json({ test: { ...result, accountRevision: revision }, account: normalAccountView(current) });
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "normal_account_storage_failed");
    const usable = "test_lease_until>unixepoch() AND enabled=1 AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM users u WHERE u.id=normal_accounts.user_id AND u.status='active')";
    await env.DB.prepare(`UPDATE normal_accounts SET tested_at=CASE WHEN ${usable} THEN ? ELSE tested_at END,
      test_error=CASE WHEN ${usable} THEN ? ELSE test_error END,
      inbox_uid_validity=CASE WHEN ${usable} THEN NULL ELSE inbox_uid_validity END,
      inbox_messages=CASE WHEN ${usable} THEN NULL ELSE inbox_messages END,test_token=NULL,test_lease_until=NULL
      WHERE id=? AND user_id=? AND revision=? AND test_token=?`).bind(unixNow(), failure.code, id, identity.userId, revision, token).run();
    throw failure;
  }
}
