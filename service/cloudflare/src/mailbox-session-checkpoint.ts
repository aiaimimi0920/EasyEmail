import type { Env } from "./contracts";
import { HttpError } from "./http";
import { encryptCredential } from "./mailbox-vault";
import type { OwnedMailbox } from "./mailbox-sync";
import type { MailReadContext, ProviderConfig } from "./providers/contracts";
import { PROVIDER_REVISION_FENCE } from "./providers/settings";
import { MAILBOX_EXPIRY_FENCE } from "./mailbox-expiry";

// Credential rotation is protocol state, not a successful mail-cache commit.
export function mailboxSessionCheckpoint(env: Env, row: OwnedMailbox, config: ProviderConfig, lease: string): MailReadContext {
  let previous = row.credential_cipher;
  return { async checkpointCredential(credential) {
    const cipher = await encryptCredential(env, row, credential);
    let result;
    try {
      result = await env.DB.prepare(`UPDATE mailboxes SET credential_cipher=? WHERE id=? AND user_id=? AND status='active'
        AND paused=0 AND disabled_at IS NULL AND released_at IS NULL AND sync_token=? AND sync_lease_until>unixepoch()
        AND credential_cipher IS ? AND ${PROVIDER_REVISION_FENCE} AND ${MAILBOX_EXPIRY_FENCE}`)
        .bind(cipher, row.id, row.user_id, lease, previous, config.id, config.revision).run();
    } catch { throw new HttpError(503, "mailbox_credential_checkpoint_failed"); }
    if (!result.meta.changes) throw new HttpError(409, "sync_lease_lost");
    previous = cipher;
  } };
}
