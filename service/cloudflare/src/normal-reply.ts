import type { Env, Identity } from "./contracts";
import { HttpError } from "./http";
import { mailAddress } from "./mail-address";
import { normalAccountView } from "./normal-account-model";
import { normalAccount } from "./normal-account-store";
import { assertNormalReplySource, normalReplySource, normalReplySourceFence, type NormalReplyOptions, type NormalReplySource } from "./normal-reply-source";
import type { JobClaim } from "./send-job-reservation";
import { normalObject } from "./normal-inbox-objects";
import { parseNormalMimeParts } from "./normal-mime-content";
import { normalMimeHeaders } from "./normal-mime-headers";
import { addressParser } from "postal-mime";

export interface NormalReply extends NormalReplySource {
  to: string; subject: string; inReplyTo: string | null; references: string[];
}
export async function resolveNormalReply(env: Env, identity: Identity, accountId: string, id: string, options: NormalReplyOptions = {}): Promise<NormalReply> {
  const { row, source } = await normalReplySource(env, identity, accountId, id, options);
  const parsed = await parseNormalMimeParts(await normalObject(env, row.raw_key, row.raw_bytes, row.raw_sha256));
  const hasReply = parsed.headers.some(header => header.key.toLowerCase() === "reply-to");
  const fields = parsed.headers.filter(header => header.key.toLowerCase() === (hasReply ? "reply-to" : "from"));
  const value = fields.length === 1 ? fields[0].value : "";
  const targets = value.length <= 8192 && !/[\r\n\x00-\x1f\x7f]/.test(value.replace(/\t/g, "")) ? addressParser(value) : [];
  const target = targets.length === 1 ? targets[0] : null;
  const to = target && !target.group ? mailAddress(target.address) : null;
  if (!to) throw new HttpError(400, "invalid_reply_source");
  const headers = normalMimeHeaders(parsed.headers), own = headers.rfcMessageId;
  const chain = headers.threadHeaders?.references ?? [], parents = headers.threadHeaders?.inReplyTo ?? [];
  const references = own ? [...new Set([...(chain.length ? chain : parents.length === 1 ? parents : []), own])] : [];
  const title = (parsed.subject ?? "").replace(/[\x00-\x1f\x7f]/g, " ").trim();
  const subject = (/^re\s*:/i.test(title) ? title : `Re: ${title}`).slice(0, 200).replace(/[\uD800-\uDBFF]$/, "");
  await assertNormalReplySource(env, identity, source, options.claim);
  return { ...source, to, subject, inReplyTo: own, references };
}
export function normalReplyFence(identity: Identity, reply: NormalReply | null, claim?: JobClaim) {
  return reply ? normalReplySourceFence(identity, reply, claim) : { sql: "1", values: [] };
}
export async function normalReplyPreview(request: Request, env: Env, identity: Identity, accountId: string, id: string, folderId = "") {
  if (new URL(request.url).search) throw new HttpError(400, "invalid_filter");
  const reply = await resolveNormalReply(env, identity, accountId, id, { folderId });
  const account = await normalAccount(env, identity.userId, accountId);
  if (!account || account.revision !== reply.accountRevision) throw new HttpError(409, "normal_account_changed");
  await assertNormalReplySource(env, identity, reply);
  return { account: normalAccountView(account), reply: { accountId, accountRevision: reply.accountRevision, messageId: id,
    ...(reply.context.serverFolderId ? { serverFolderId: reply.context.serverFolderId } : {}),
    to: reply.to, subject: reply.subject, threading: reply.inReplyTo ? "available" : "unavailable" } };
}
