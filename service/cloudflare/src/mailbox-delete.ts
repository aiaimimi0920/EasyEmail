import type { Env, Identity } from "./contracts";
import { HttpError, json, readJson } from "./http";
import { requireScope, requireWriteScope } from "./identity";
import { mailboxExpired } from "./mailbox-expiry";
import { ownedMailbox, type OwnedMailbox } from "./mailbox-sync";
import { decryptCredential } from "./mailbox-vault";
import { configuredProvider, connectProvider } from "./providers/registry";
import { assertProviderRevision } from "./providers/settings";
import { rateLimit } from "./rate-limits";
import { tokenHash } from "./security";
import { assertMailboxQuiescent, finishMailboxDeletion, mailboxDeletionByKey, mailboxDeletionByMailbox,
  mailboxDeletionResponse, reserveMailboxDeletion, type MailboxDeletion } from "./mailbox-delete-store";

function deletable(box: OwnedMailbox) {
  if (box.released_at !== null) throw new HttpError(409, "mailbox_released");
  if (mailboxExpired(box)) throw new HttpError(409, "mailbox_expired");
  if (box.status !== "active") throw new HttpError(409, "mailbox_not_active");
  if (!/^[1-9]\d{0,15}$/.test(box.remote_id) || !Number.isSafeInteger(Number(box.remote_id))) throw new HttpError(409, "remote_mailbox_delete_unavailable");
}
export async function remoteMailboxDeletion(request: Request, env: Env, identity: Identity, id: string, check: boolean): Promise<Response> {
  if (request.method === "GET" && !check) {
    requireScope(identity, "mailboxes:read"); const box = await ownedMailbox(env, identity, id);
    const row = await mailboxDeletionByMailbox(env, identity, id); if (row) return mailboxDeletionResponse(row);
    let available = false;
    try { deletable(box); available = (await configuredProvider(env, box.provider_id)).type === "cloudflare"; }
    catch (error) { if (!(error instanceof HttpError) || error.status >= 500) throw error; }
    return json({ deletion: null, available });
  }
  requireWriteScope(request, env, identity, "mailboxes:remote-delete");
  const body = await readJson(request);
  if (check && Object.keys(body).length) throw new HttpError(400, "invalid_remote_mailbox_delete_request");
  const box = await ownedMailbox(env, identity, id);
  if (!check && (Object.keys(body).length !== 2 || body.confirmAddress !== box.address || body.confirmMailboxId !== id)) {
    throw new HttpError(400, "remote_mailbox_delete_confirmation_required");
  }
  const key = request.headers.get("idempotency-key") ?? "";
  if (!check && !/^[a-zA-Z0-9_-]{16,128}$/.test(key)) throw new HttpError(400, "idempotency_key_required");
  const hash = await tokenHash(JSON.stringify([id, box.address, box.remote_id]));
  const byKey = check ? null : await mailboxDeletionByKey(env, identity, key); if (byKey) return mailboxDeletionResponse(byKey, hash);
  let existing = await mailboxDeletionByMailbox(env, identity, id);
  if (existing && (!check || ["deleted", "absent", "changed"].includes(existing.state))) return mailboxDeletionResponse(existing, hash);
  if (check && !existing) throw new HttpError(404, "remote_mailbox_deletion_not_found");
  if (!check) { deletable(box); await assertMailboxQuiescent(env, id); }
  const config = await configuredProvider(env, box.provider_id);
  if (existing && (existing.provider_id !== config.id || existing.provider_revision !== config.revision || existing.provider_endpoint !== config.baseUrl)) {
    throw new HttpError(409, "provider_config_changed");
  }
  if (config.type !== "cloudflare") throw new HttpError(409, "remote_mailbox_delete_unavailable");
  const provider = await connectProvider(env, config);
  if (!provider.remoteMailboxDelete || !provider.mailboxDeleteCapability) throw new HttpError(409, "remote_mailbox_delete_unavailable");
  const credential = await decryptCredential(env, box, box.credential_cipher);
  await rateLimit(env, check ? "mailbox-delete-check" : "mailbox-delete", identity.userId, 20);
  if (!check) {
    try {
      if (!await provider.mailboxDeleteCapability(credential, { addressId: box.remote_id, address: box.address })) throw new HttpError(409, "remote_mailbox_delete_unavailable");
    } catch (error) {
      const duplicate = await mailboxDeletionByKey(env, identity, key) ?? await mailboxDeletionByMailbox(env, identity, id);
      if (duplicate) return mailboxDeletionResponse(duplicate, hash);
      throw error;
    }
    existing = await reserveMailboxDeletion(env, identity, box, config, key, hash);
    if (!existing) {
      const duplicate = await mailboxDeletionByKey(env, identity, key) ?? await mailboxDeletionByMailbox(env, identity, id);
      if (duplicate) return mailboxDeletionResponse(duplicate, hash);
      await assertProviderRevision(env, config); deletable(await ownedMailbox(env, identity, id)); await assertMailboxQuiescent(env, id);
      throw new HttpError(409, "mailbox_state_changed");
    }
  }
  const row = existing!;
  let state: MailboxDeletion["state"] = "unknown", error: string | null = null;
  try { state = await provider.remoteMailboxDelete(credential, { requestId: row.id, addressId: row.remote_id, address: row.address }, check); }
  catch (failure) { error = failure instanceof HttpError ? failure.code : "remote_mailbox_delete_outcome_unknown"; }
  return mailboxDeletionResponse(await finishMailboxDeletion(env, row, state, error));
}
