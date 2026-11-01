import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { imapEndpoint } from "./normal-account-input";
import { agentAccountTestRevision } from "./agent-account-input";
import { agentAccount, agentAccountContext, agentAccountCredentialFence } from "./agent-account-store";
import { agentAccountView } from "./agent-account-model";
import { agentMailAuthentication } from "./agent-mail-authentication";
import { rateLimit } from "./rate-limits";
import { testImapConnection } from "./normal-imap-client";

export async function testAgentAccount(request: Request, env: Env, identity: Identity, id: string) {
  const revision = agentAccountTestRevision(await readJson(request)), row = await agentAccount(env, identity.userId, id);
  if (!row || row.deleted_at !== null) throw new HttpError(404, "not_found");
  if (row.revision !== revision) throw new HttpError(409, "agent_account_changed");
  if (!row.enabled) throw new HttpError(409, "agent_account_disabled");
  const endpoint = await imapEndpoint(env, row.endpoint_id);
  if (endpoint.hash !== row.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "agent-account-test", identity.userId, 5);
  await rateLimit(env, "normal-account-test-global", "platform", 30);
  const token = crypto.randomUUID(), credentialFence = agentAccountCredentialFence(identity);
  const acquired = await env.DB.prepare(`UPDATE agent_accounts SET test_token=?,test_lease_until=unixepoch()+45 WHERE id=? AND user_id=?
    AND revision=? AND enabled=1 AND deleted_at IS NULL AND (test_lease_until IS NULL OR test_lease_until<=unixepoch()) AND ${credentialFence}`)
    .bind(token, id, identity.userId, revision, identity.credentialId, identity.userId).run();
  if (!acquired.meta.changes) throw new HttpError(409, "agent_account_busy_or_changed");
  try {
    const credential = await agentMailAuthentication(env, row, row.credential_cipher, agentAccountContext(id, identity.userId), endpoint, row.username);
    const live = `EXISTS(SELECT 1 FROM agent_accounts WHERE id=? AND user_id=? AND revision=? AND test_token=? AND test_lease_until>unixepoch() AND enabled=1 AND deleted_at IS NULL)
      AND ${credentialFence} AND ${credential.fence.sql}`;
    const values = [id, identity.userId, revision, token, identity.credentialId, identity.userId, ...credential.fence.values];
    if (!await env.DB.prepare(`SELECT 1 WHERE ${live}`).bind(...values).first()) throw new HttpError(409, "agent_account_changed");
    const result = await testImapConnection(endpoint, row.username, credential.authentication);
    const stored = await env.DB.prepare(`UPDATE agent_accounts SET tested_at=?,test_error=NULL,inbox_uid_validity=?,inbox_messages=?,test_token=NULL,test_lease_until=NULL
      WHERE ${live}`)
      .bind(unixNow(), result.inbox.uidValidity, result.inbox.messages, ...values).run();
    if (!stored.meta.changes) throw new HttpError(409, "agent_account_changed");
    const current = await agentAccount(env, identity.userId, id);
    if (!current || current.revision !== revision || !current.enabled || current.deleted_at !== null) throw new HttpError(409, "agent_account_changed");
    return json({ test: { ...result, accountRevision: revision }, account: agentAccountView(current) });
  } catch (error) {
    const failure = error instanceof HttpError ? error : new HttpError(503, "agent_account_storage_failed");
    const usable = `test_lease_until>unixepoch() AND enabled=1 AND deleted_at IS NULL AND ${credentialFence}`;
    await env.DB.prepare(`UPDATE agent_accounts SET tested_at=CASE WHEN ${usable} THEN ? ELSE tested_at END,
      test_error=CASE WHEN ${usable} THEN ? ELSE test_error END,
      inbox_uid_validity=CASE WHEN ${usable} THEN NULL ELSE inbox_uid_validity END,
      inbox_messages=CASE WHEN ${usable} THEN NULL ELSE inbox_messages END,test_token=NULL,test_lease_until=NULL
      WHERE id=? AND user_id=? AND revision=? AND test_token=?`)
      .bind(identity.credentialId, identity.userId, unixNow(), identity.credentialId, identity.userId, failure.code,
        identity.credentialId, identity.userId, identity.credentialId, identity.userId, id, identity.userId, revision, token).run();
    throw failure;
  }
}
