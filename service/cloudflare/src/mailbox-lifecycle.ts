import { unixNow, type Env, type Identity } from "./contracts";
import { HttpError, readJson } from "./http";
import { requireWriteScope } from "./identity";
import { getMailbox } from "./mailbox-queries";
import { ownedMailbox } from "./mailbox-sync";
import { mailboxExpired, MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";
import { mailboxDeletionByMailbox } from "./mailbox-delete-store";

export async function mailboxLifecycle(request: Request, env: Env, identity: Identity, id: string): Promise<Response> {
  const body = await readJson(request);
  if (typeof body.action !== "string" || !["disable", "enable", "release"].includes(body.action)
    || Object.keys(body).some((key) => !["action", "confirmAddress"].includes(key))) throw new HttpError(400, "invalid_lifecycle_request");
  requireWriteScope(request, env, identity, body.action === "release" ? "mailboxes:delete" : "mailboxes:write");
  const row = await ownedMailbox(env, identity, id);
  if (body.action === "release" && body.confirmAddress !== row.address) throw new HttpError(400, "release_confirmation_required");
  if (body.action !== "release" && body.confirmAddress !== undefined) throw new HttpError(400, "invalid_lifecycle_request");
  if (body.action === "enable" && row.released_at !== null) throw new HttpError(409, "mailbox_released");
  if (body.action === "disable" && row.released_at !== null) throw new HttpError(409, "mailbox_released");
  if (body.action !== "release" && mailboxExpired(row)) throw new HttpError(409, "mailbox_expired");
  const now = unixNow();
  const assignments = body.action === "enable" ? "disabled_at = NULL" : body.action === "disable"
    ? "disabled_at = COALESCE(disabled_at, ?)" : "released_at = COALESCE(released_at, ?), disabled_at = COALESCE(disabled_at, ?), credential_cipher = NULL";
  const values = body.action === "enable" ? [] : body.action === "disable" ? [now] : [now, now];
  // A transition fences in-flight sync. Repeated no-op requests do not cancel a newer lease.
  const condition = body.action === "enable" ? "disabled_at IS NOT NULL AND released_at IS NULL"
    : body.action === "disable" ? "disabled_at IS NULL AND released_at IS NULL" : "released_at IS NULL";
  await env.DB.prepare(`UPDATE mailboxes SET ${assignments}, sync_token = NULL, sync_lease_until = NULL,
    sync_revision = sync_revision + 1 WHERE id = ? AND user_id = ? AND ${condition}
    ${body.action === "enable" ? "AND NOT EXISTS(SELECT 1 FROM remote_mailbox_deletions WHERE mailbox_id=mailboxes.id)" : ""}
    ${body.action === "release" ? "" : `AND ${MAILBOX_EXPIRY_FENCE}`}`)
    .bind(...values, id, identity.userId).run();
  const current = await ownedMailbox(env, identity, id);
  if (body.action !== "release" && current.released_at !== null) throw new HttpError(409, "mailbox_released");
  if (body.action !== "release" && mailboxExpired(current)) throw new HttpError(409, "mailbox_expired");
  if (body.action === "enable" && await mailboxDeletionByMailbox(env, identity, id)) throw new HttpError(409, "remote_mailbox_delete_in_progress");
  return getMailbox(env, { ...identity, scopes: [...identity.scopes, "mailboxes:read"] }, id);
}
