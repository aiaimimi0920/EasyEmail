import { HttpError } from "./http";
import type { readImapMessages } from "./normal-imap-client";
import { assertImapCursor } from "./normal-imap-read";
import { parseNormalMime, type NormalMimeContent } from "./normal-mime-content";
import type { InboxClaim } from "./normal-inbox-claim";
import { tokenHash } from "./security";

export interface InboxItem {
  id: string; uid: number; rawKey: string; contentKey: string; rawSha256: string; contentSha256: string;
  rawBytes: number; contentBytes: number; receivedAt: number; flags: string[];
  summary?: { sender: string; recipient: string; subject: string };
  replyEvidence?: { from: string | null; limited: boolean; candidates: string[]; messageId: string | null };
}
export interface InboxManifest { items: InboxItem[]; skipped: { uid: number; reason: string }[] }
export interface InboxPlan {
  epochId: string; uidValidity: string; afterUid: number; reset: boolean; complete: boolean;
  manifest: InboxManifest; objects: { key: string; bytes: Uint8Array; sha256: string }[]; storageBytes: number;
  contents: Map<string, NormalMimeContent>;
}
export async function planNormalInbox(claim: Pick<InboxClaim, "userId" | "accountId" | "token" | "cursor" | "epochId" | "version" | "serverFolder">,
  recipient: string, batch: Awaited<ReturnType<typeof readImapMessages>>, namespace: "normal-inbox/v1" | "agent-inbox/v1" = "normal-inbox/v1"): Promise<InboxPlan> {
  assertImapCursor(batch.cursor);
  if (claim.serverFolder && batch.inbox.path !== claim.serverFolder.wireName) throw new HttpError(502, "invalid_normal_batch");
  const validity = batch.cursor.uidValidity, sameEpoch = claim.cursor?.uidValidity === validity;
  const start = sameEpoch ? claim.cursor!.afterUid : 0, end = batch.cursor.afterUid;
  const uids = [...batch.items, ...batch.skipped].map(item => item.uid);
  if (batch.reset !== (claim.cursor !== null && !sameEpoch) || batch.inbox.uidValidity !== validity
    || !Number.isSafeInteger(batch.uidNext) || batch.uidNext < 1 || batch.uidNext > 4294967295
    || end < start || end > start + 100 || end >= batch.uidNext || batch.complete !== (end === batch.uidNext - 1)
    || uids.length > 3 || new Set(uids).size !== uids.length || uids.some(uid => !Number.isInteger(uid) || uid <= start || uid > end)
    || batch.skipped.some(item => !["message_missing", "message_too_large"].includes(item.reason))) throw new HttpError(502, "invalid_normal_batch");
  const epochId = sameEpoch && claim.epochId ? claim.epochId : crypto.randomUUID();
  const plan: InboxPlan = { epochId, uidValidity: validity, afterUid: end,
    reset: claim.version > 0 && (!sameEpoch || !claim.epochId), complete: batch.complete,
    manifest: { items: [], skipped: batch.skipped }, objects: [], contents: new Map(), storageBytes: 0 };
  for (const item of batch.items) {
    const parsed = await parseNormalMime(item.raw, recipient, item.receivedAt, namespace === "agent-inbox/v1", !!claim.serverFolder);
    const content = JSON.stringify(parsed.content), bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > 2 * 1024 * 1024) throw new HttpError(502, "normal_content_too_large");
    const prefix = `${namespace}/${claim.userId}/${claim.accountId}/${claim.token}/${item.uid}`;
    const metadata: InboxItem = { id: crypto.randomUUID(), uid: item.uid, rawKey: `${prefix}.eml`, contentKey: `${prefix}.json`,
      rawSha256: parsed.rawSha256, contentSha256: await tokenHash(content), rawBytes: item.raw.byteLength,
      contentBytes: bytes.byteLength, receivedAt: item.receivedAt, flags: item.flags,
      summary: { sender: parsed.content.sender, recipient: parsed.content.headerRecipient ?? parsed.content.recipient, subject: parsed.content.subject } };
    if (namespace === "agent-inbox/v1") metadata.replyEvidence = {
      from: parsed.replyEvidence?.from ?? null, limited: !!parsed.replyEvidence?.limited || !!parsed.content.threadHeaders?.limited,
      candidates: [...new Set([...(parsed.content.threadHeaders?.inReplyTo ?? []), ...(parsed.content.threadHeaders?.references ?? [])].map(value => value.toLowerCase()))],
      messageId: parsed.content.rfcMessageId ?? null,
    };
    plan.manifest.items.push(metadata);
    plan.contents.set(metadata.id, parsed.content);
    plan.objects.push({ key: metadata.rawKey, bytes: item.raw, sha256: metadata.rawSha256 },
      { key: metadata.contentKey, bytes, sha256: metadata.contentSha256 });
    plan.storageBytes += item.raw.byteLength + bytes.byteLength;
  }
  return plan;
}
