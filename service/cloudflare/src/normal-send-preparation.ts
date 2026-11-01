import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { normalMailAuthentication } from "./normal-mail-authentication";
import { normalAccount } from "./normal-account-store";
import { allRecipients } from "./outgoing-recipients";
import { smtpEndpoint } from "./smtp-config-input";
import { smtpConfig, smtpContext } from "./smtp-config-store";
import { normalReplyFence, resolveNormalReply } from "./normal-reply";
import type { NormalSendInput } from "./normal-send-input";
import type { JobClaim } from "./send-job-reservation";

export async function prepareNormalSend(env: Env, identity: Identity, accountId: string, input: NormalSendInput, claim?: JobClaim) {
  const account = await normalAccount(env, identity.userId, accountId), config = await smtpConfig(env, identity.userId, accountId);
  if (!account || account.deleted_at !== null) throw new HttpError(404, "not_found");
  if (!account.enabled) throw new HttpError(409, "normal_account_disabled");
  const reply = input.reply ? await resolveNormalReply(env, identity, accountId, input.reply, { claim }) : null;
  if (reply && reply.accountRevision !== input.accountRevision) throw new HttpError(409, "normal_account_changed");
  if (account.revision !== input.accountRevision || !config || config.revision !== input.smtpRevision || config.account_revision !== input.accountRevision) throw new HttpError(409, "smtp_config_changed");
  if (!config.enabled || !config.credential_cipher) throw new HttpError(409, "smtp_credential_required");
  const endpoint = await smtpEndpoint(env, config.endpoint_id);
  if (endpoint.hash !== config.endpoint_hash) throw new HttpError(409, "smtp_endpoint_changed");
  const recipients = allRecipients(input);
  if (!endpoint.recipients.includes("*") && recipients.some(address => !endpoint.recipients.includes(address.toLowerCase()))) throw new HttpError(403, "recipient_not_allowed");
  const credential = await normalMailAuthentication(env, account, config.credential_cipher, smtpContext(accountId, identity.userId), endpoint, config.username);
  return { account, config, endpoint, recipients, credential, reply, replyFence: normalReplyFence(identity, reply, claim) };
}
