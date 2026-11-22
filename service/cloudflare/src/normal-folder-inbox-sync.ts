import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { imapEndpoint } from "./normal-account-input";
import { normalContext } from "./normal-account-store";
import { claimFolderInbox, releaseFolderInbox } from "./normal-folder-inbox-claim";
import type { FolderInboxTarget } from "./normal-folder-inbox-target";
import { claimValues, receiveClaimFence } from "./normal-inbox-claim";
import { planNormalInbox } from "./normal-inbox-plan";
import { stageNormalInbox, commitNormalInbox } from "./normal-inbox-store";
import { readImapFolderMessages } from "./normal-imap-client";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { rateLimit } from "./rate-limits";

export async function syncFolderInbox(env: Env, identity: Identity, target: FolderInboxTarget, requestId: string) {
  if (!env.INBOX) throw new HttpError(503, "normal_inbox_not_configured");
  const account = target.account, endpoint = await imapEndpoint(env, account.endpoint_id);
  if (endpoint.hash !== account.endpoint_hash) throw new HttpError(409, "imap_endpoint_changed");
  await rateLimit(env, "normal-inbox-sync", identity.userId, 10);
  await rateLimit(env, "normal-inbox-sync-global", "platform", 60);
  const claim = await claimFolderInbox(env, identity, target, requestId);
  try {
    const credential = await normalMailAuthentication(env, account, account.credential_cipher,
      normalContext(account.id, identity.userId), endpoint, account.username);
    claim.receiveFence = { sql: `${claim.receiveFence!.sql} AND ${credential.fence.sql}`,
      values: [...claim.receiveFence!.values, ...credential.fence.values] };
    // Authentication may refresh OAuth. Revalidate the exact lease, directory, owner and caller before opening a socket.
    if (!await env.DB.prepare(`SELECT 1 WHERE ${receiveClaimFence(claim)}`).bind(...claimValues(claim)).first()) {
      throw new HttpError(409, "normal_inbox_changed");
    }
    const batch = await readImapFolderMessages(endpoint, account.username, credential.authentication, target.wireName, claim.cursor);
    const plan = await planNormalInbox(claim, account.email_address, batch);
    await stageNormalInbox(env, claim, plan);
    for (const object of plan.objects) {
      const written = await env.INBOX.put(object.key, object.bytes, { sha256: object.sha256, onlyIf: { etagDoesNotMatch: "*" } });
      if (!written) throw new HttpError(503, "normal_inbox_storage_failed");
    }
    return await commitNormalInbox(env, claim, plan.contents);
  } catch (error) {
    // Preserve tracked objects on ambiguous storage responses; a retry only reconciles its original request.
    throw error instanceof HttpError ? error : new HttpError(503, "normal_inbox_storage_failed");
  } finally { await releaseFolderInbox(env, claim).catch(() => {}); }
}
