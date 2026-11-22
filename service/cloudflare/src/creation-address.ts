import type { Env } from "./contracts";
import { HttpError } from "./http";
import { mailAddress, validDomain } from "./mail-address";

interface CreationAddress { mailbox_id: string; address: string }
const PREFIX = "remote-random:";

// A non-deliverable internal reservation, never a guessed mailbox or an upstream input.
export const remoteCreationReservation = (id: string, domain: string) => `${PREFIX}${id}:${domain}`;

export function creationAddressView(row: CreationAddress): { address: string | null; addressPending?: true; requestedDomain?: string } {
  if (!row.address.startsWith(PREFIX)) return { address: row.address };
  const prefix = `${PREFIX}${row.mailbox_id}:`, domain = row.address.slice(prefix.length);
  if (!row.address.startsWith(prefix) || !validDomain(domain)) throw new HttpError(503, "creation_storage_failed");
  return { address: null, addressPending: true, requestedDomain: domain };
}

export async function bindCreationAddress(env: Env, userId: string, id: string, reserved: string, value: unknown): Promise<string> {
  const domain = creationAddressView({ mailbox_id: id, address: reserved }).requestedDomain, address = mailAddress(value);
  if (!domain || !address || address !== value || address.split("@")[1] !== domain) throw new HttpError(502, "provider_recipient_mismatch");
  const conflict = () => env.DB.prepare(`SELECT 1 FROM mailbox_creations WHERE address=? COLLATE NOCASE AND mailbox_id<>?
    UNION ALL SELECT 1 FROM mailboxes WHERE address=? COLLATE NOCASE LIMIT 1`).bind(address, id, address).first();
  let changed: number;
  try {
    const result = await env.DB.prepare(`UPDATE mailbox_creations SET address=? WHERE user_id=? AND mailbox_id=? AND address=? AND state='pending'
      AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address=? COLLATE NOCASE)`).bind(address, userId, id, reserved, address).run();
    changed = result.meta.changes;
  } catch (error) {
    if (await conflict()) throw new HttpError(409, "mailbox_address_unavailable");
    throw error;
  }
  if (!changed) throw new HttpError(409, await conflict() ? "mailbox_address_unavailable" : "creation_state_changed");
  return address;
}
