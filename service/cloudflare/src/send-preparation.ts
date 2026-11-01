import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { mailAddress, rfcMessageId } from "./mail-address";
import { ownedMailbox } from "./mailbox-sync";
import { assertMailboxUsable } from "./mailbox-access";
import { configuredProvider } from "./providers/registry";
import { allRecipients, extendedRecipients } from "./outgoing-recipients";
import type { SendInput } from "./send-input";

// Eligibility is checked both when accepting intent and immediately before reservation.
// Enqueue resolves immutable metadata only; it never downloads R2 bytes or contacts a provider.
export async function prepareSend(env: Env, identity: Identity, mailboxId: string, input: SendInput) {
  const mailbox = await ownedMailbox(env, identity, mailboxId); assertMailboxUsable(mailbox);
  const config = await configuredProvider(env, mailbox.provider_id);
  if (!config.sendTransport || config.type !== "cloudflare" || !config.sendRecipients.length) throw new HttpError(409, "sending_disabled");
  if (!config.domains.includes(mailbox.address.split("@")[1]) || !mailAddress(mailbox.address)) throw new HttpError(409, "sender_unavailable");
  if (config.sendTransport !== "binding" && extendedRecipients(input)) throw new HttpError(409, "multiple_recipients_unavailable");
  if (config.sendTransport !== "binding" && input.attachments.length) throw new HttpError(409, "attachment_send_unavailable");
  const recipients = allRecipients(input);
  if (!config.sendRecipients.includes("*") && recipients.some(to => !config.sendRecipients.includes(to.toLowerCase()))) throw new HttpError(403, "recipient_not_allowed");
  const source = input.reply ? await env.DB.prepare(`SELECT rfc_message_id FROM messages
    WHERE user_id = ? AND mailbox_id = ? AND id = ? AND trashed_at IS NULL AND purged_at IS NULL`).bind(identity.userId, mailboxId, input.reply)
    .first<{ rfc_message_id: string | null }>() : null;
  if (input.reply && !source) throw new HttpError(400, "invalid_reply_source");
  const replyId = rfcMessageId(source?.rfc_message_id);
  const threading = input.reply ? config.sendTransport === "binding" && replyId ? "submitted" : "unavailable" : "none";
  return { mailbox, config, replyId, threading };
}
