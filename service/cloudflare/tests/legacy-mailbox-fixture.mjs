import { createHash, webcrypto } from "node:crypto";

// Independently serialize the old AES-GCM envelope; current handlers require current schema.
export async function seedLegacyCloudflare(h, f, userId) {
  const id = crypto.randomUUID(), address = `legacy-${id}@cf.example.test`, now = Math.floor(Date.now() / 1000);
  const token = `synthetic-mail-jwt-${id}`, remoteId = f.mailboxes.size + 1;
  const key = await webcrypto.subtle.importKey("raw", Buffer.from("a3".repeat(32), "hex"), "AES-GCM", false, ["encrypt"]);
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = await webcrypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: Buffer.from(JSON.stringify(["ee-mailbox-v1", id, userId, "self"])) }, key, Buffer.from(JSON.stringify({ token })));
  const sealed = JSON.stringify({ v: 1, key: "k1", iv: [...iv], cipher: [...new Uint8Array(cipher)] });
  await h.db.prepare(`INSERT INTO mailboxes(id,user_id,provider_id,remote_id,address,status,created_at,credential_cipher)
    VALUES (?,?,'self',?,?,'active',?,?)`).bind(id, userId, String(remoteId), address, now, sealed).run();
  await h.db.prepare(`INSERT INTO mailbox_creations(user_id,request_key,request_hash,mailbox_id,address,state,created_at)
    VALUES (?,?,?,?,?,'complete',?)`).bind(userId, crypto.randomUUID(),
    createHash("sha256").update(JSON.stringify(["self", "cf.example.test"])).digest("hex"), id, address, now).run();
  f.mailboxes.set(address, { token, id: remoteId });
  return { id, address };
}
