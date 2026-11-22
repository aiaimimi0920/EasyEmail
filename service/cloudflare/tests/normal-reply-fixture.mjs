import { createHash } from "node:crypto";
import { normalSendFixture } from "./normal-send-fixture.mjs";

export const replyRaw = (headers = "Reply-To: Support <support@example.test>\r\nMessage-ID: <original@example.test>\r\nReferences: <root@example.test>") =>
  `From: Sender <sender@example.test>\r\nTo: alice@example.test\r\nSubject: Reply acceptance\r\n${headers}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nOriginal message`;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
export async function normalReplyFixture(browser = false, resources = {}) {
  const t = await normalSendFixture(browser, { ...resources, r2Buckets: { ...resources.r2Buckets, INBOX: "normal-reply-fixture" } });
  async function seed(raw = replyRaw(), accountId = t.id) {
    const account = await t.h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(accountId).first();
    const source = hash(JSON.stringify(["normal-inbox-v1", account.endpoint_hash, account.username, account.email_address, "INBOX"]));
    const old = await t.h.db.prepare("SELECT * FROM normal_inbox_state WHERE account_id=?").bind(accountId).first();
    const epoch = old?.epoch_id ?? crypto.randomUUID(), uid = (old?.after_uid ?? 0) + 1, id = crypto.randomUUID(), batch = crypto.randomUUID();
    const content = { sender: "Sender <sender@example.test>", recipient: account.email_address, subject: "Reply acceptance", textBody: "Original message", htmlBody: "",
      receivedAt: 1, attachments: [], attachmentsTruncated: false, rfcMessageId: "<original@example.test>", threadHeaders: { inReplyTo: [], references: ["<root@example.test>"], limited: false } };
    const bytes = Buffer.from(raw), body = Buffer.from(JSON.stringify(content)), rawKey = `reply/${id}/raw`, contentKey = `reply/${id}/content`, bucket = await t.h.bucket("INBOX");
    await bucket.put(rawKey, bytes); await bucket.put(contentKey, body);
    await t.h.db.batch([
      t.h.db.prepare(`INSERT INTO normal_inbox_state(account_id,source_hash,epoch_id,uid_validity,after_uid,version) VALUES (?,?,?,'42',?,1)
        ON CONFLICT(account_id) DO UPDATE SET source_hash=excluded.source_hash,epoch_id=excluded.epoch_id,after_uid=excluded.after_uid`).bind(accountId, source, epoch, uid),
      t.h.db.prepare(`INSERT INTO normal_inbox_batches(id,account_id,account_revision,source_hash,from_version,epoch_id,uid_validity,after_uid,reset,complete,item_count,storage_bytes,manifest,status,created_at,committed_at)
        VALUES (?,?,?,?,0,?,'42',?,0,1,1,?,'{}','committed',1,1)`).bind(batch, accountId, account.revision, source, epoch, uid, bytes.length + body.length),
      t.h.db.prepare(`INSERT INTO normal_inbox_messages(id,account_id,batch_id,epoch_id,uid_validity,uid,raw_key,content_key,raw_sha256,content_sha256,raw_bytes,content_bytes,received_at,flags,observed_at)
        VALUES (?,?,?,?,'42',?,?,?,?,?,?,?,1,'[]',1)`).bind(id, accountId, batch, epoch, uid, rawKey, contentKey, hash(bytes), hash(body), bytes.length, body.length),
    ]);
    return { id, accountId, epoch, rawKey, contentKey, source, path: `/api/v1/normal-accounts/${accountId}/messages/${id}` };
  }
  return { ...t, seed };
}
