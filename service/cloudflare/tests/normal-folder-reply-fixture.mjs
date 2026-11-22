import { createHash } from "node:crypto";
import { normalReplyFixture, replyRaw } from "./normal-reply-fixture.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
export async function folderReplyFixture(browser = false) {
  const t = await normalReplyFixture(browser, { r2Buckets: { OUTBOX: "folder-reply-outbox" } });
  async function seedFolder(wireName = "Archive", raw = replyRaw("Reply-To: archive@example.test\r\nMessage-ID: <archive@example.test>\r\nReferences: <folder-root@example.test>")) {
    const original = await t.seed(raw), account = await t.h.db.prepare("SELECT * FROM normal_accounts WHERE id=?").bind(t.id).first();
    const catalogSource = hash(JSON.stringify(["normal-server-folders-v1", account.endpoint_hash, account.username, account.email_address]));
    const folderId = hash(JSON.stringify(["normal-server-folder-v1", t.id, catalogSource, wireName]));
    const source = hash(JSON.stringify(["normal-server-folder-inbox-v1", t.id, catalogSource, wireName])), epoch = crypto.randomUUID();
    const folder = { id: folderId, name: wireName, wireName, selectable: true, attributes: [], roles: [], delimiter: "/" };
    const catalog = await t.h.db.prepare("SELECT folders FROM normal_server_folder_catalogs WHERE account_id=?").bind(t.id).first("folders");
    const folders = [...(catalog ? JSON.parse(catalog).filter(f => f.id !== folderId) : []), folder];
    await t.h.db.batch([
      t.h.db.prepare(`INSERT INTO normal_server_folder_catalogs(account_id,source_hash,snapshot_id,snapshot_revision,folders,observed_at) VALUES (?,?,?,1,?,1)
        ON CONFLICT(account_id) DO UPDATE SET source_hash=excluded.source_hash,snapshot_id=excluded.snapshot_id,folders=excluded.folders`)
        .bind(t.id, catalogSource, crypto.randomUUID(), JSON.stringify(folders)),
      t.h.db.prepare(`INSERT INTO normal_server_folder_state(account_id,server_folder_id,wire_name,source_hash,epoch_id,uid_validity,after_uid,version)
        VALUES (?,?,?,?,?,'42',1,1) ON CONFLICT(account_id,server_folder_id) DO UPDATE SET source_hash=excluded.source_hash,epoch_id=excluded.epoch_id,after_uid=1`)
        .bind(t.id, folderId, wireName, source, epoch),
      t.h.db.prepare("UPDATE normal_inbox_batches SET server_folder_id=?,epoch_id=?,source_hash=?,after_uid=1 WHERE id=(SELECT batch_id FROM normal_inbox_messages WHERE id=?)")
        .bind(folderId, epoch, source, original.id),
      t.h.db.prepare("UPDATE normal_inbox_messages SET server_folder_id=?,epoch_id=?,uid=1 WHERE id=?").bind(folderId, epoch, original.id),
      t.h.db.prepare("UPDATE normal_inbox_state SET after_uid=0 WHERE account_id=?").bind(t.id),
    ]);
    return { ...original, epoch, source, folderId, wireName, catalogSource, path: `${t.path}/server-folders/${folderId}/messages/${original.id}` };
  }
  return { ...t, seedFolder,
    enqueue(body, key = crypto.randomUUID(), extra = {}) { return t.h.request(`${t.path}/send-jobs`, {
      method: "POST", cookie: t.alice.cookie, headers: { "idempotency-key": key }, body, ...extra }); },
    tick() { return t.h.scheduled(Date.now(), "* * * * *"); },
  };
}
