import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { requireScope } from "./identity";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { imapEndpoint } from "./normal-account-input";
import { normalAccount, normalContext } from "./normal-account-store";
import { claimNormalInbox, normalInboxSourceHash, releaseNormalInbox } from "./normal-inbox-claim";
import { planNormalInbox } from "./normal-inbox-plan";
import { stageNormalInbox, commitNormalInbox } from "./normal-inbox-store";
import { readImapMessages } from "./normal-imap-client";
import { rateLimit } from "./rate-limits";
import type { ReceiveFence } from "./normal-folder-inbox-target";
import { claimValues, receiveClaimFence } from "./normal-inbox-claim";

// Internal receive primitive only. Public routes must add source-aware read and attachment authorization first.
export async function syncNormalInbox(env: Env, identity: Identity, id: string, revision: number, requestId?: string, receiveFence?: ReceiveFence) {
  requireScope(identity, "mail-accounts:sync");
  const account = await normalAccount(env, identity.userId, id);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  if (account.revision !== revision) throw new HttpError(409, "normal_account_changed");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  if (!env.INBOX) throw new HttpError(503, "normal_inbox_not_configured");
  const endpoint = await imapEndpoint(env, account.endpoint_id);
  if (endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "normal-inbox-sync", identity.userId, 10);
  await rateLimit(env, "normal-inbox-sync-global", "platform", 60);
  const sourceHash = await normalInboxSourceHash(account);
  const claim = await claimNormalInbox(env, account, sourceHash, requestId);
  claim.receiveFence = receiveFence;
  try {
    const credential = await normalMailAuthentication(env, account, account.credential_cipher, normalContext(id, identity.userId), endpoint, account.username);
    if (receiveFence) {
      claim.receiveFence = { sql: `${receiveFence.sql} AND ${credential.fence.sql}`, values: [...receiveFence.values, ...credential.fence.values] };
      if (!await env.DB.prepare(`SELECT 1 WHERE ${receiveClaimFence(claim)}`).bind(...claimValues(claim)).first()) throw new HttpError(409, "normal_inbox_changed");
    }
    const batch = await readImapMessages(endpoint, account.username, credential.authentication, claim.cursor);
    const plan = await planNormalInbox(claim, account.email_address, batch);
    await stageNormalInbox(env, claim, plan);
    for (const object of plan.objects) {
      const written = await env.INBOX.put(object.key, object.bytes, { sha256: object.sha256, onlyIf: { etagDoesNotMatch: "*" } });
      if (!written) throw new HttpError(503, "normal_inbox_storage_failed");
    }
    return await commitNormalInbox(env, claim, plan.contents);
  } catch (error) {
    // An ambiguous database result can already be committed. Preserve its objects and tracked intent; never delete here.
    throw error instanceof HttpError ? error : new HttpError(503, "normal_inbox_storage_failed");
  } finally {
    // The bounded lease remains the fallback if best-effort cleanup fails; never mask a committed receipt or original error.
    await releaseNormalInbox(env, claim).catch(() => {});
  }
}
