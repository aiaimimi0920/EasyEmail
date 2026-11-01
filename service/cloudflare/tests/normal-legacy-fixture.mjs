import { createCipheriv, createHash, randomBytes } from "node:crypto";

// Encode the pre-OAuth format independently of the new runtime. Historical migration
// fixtures must not run new account writers against a deliberately older schema.
export async function seedLegacyNormalAccount(h, userId, id, input) {
  const iv = randomBytes(12), key = Buffer.from("c5".repeat(32), "hex"), cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(JSON.stringify(["ee-normal-account-v1", id, userId, "normal-imap-v1"])));
  const bytes = Buffer.concat([cipher.update(JSON.stringify({ token: input.password }), "utf8"), cipher.final(), cipher.getAuthTag()]);
  const sealed = JSON.stringify({ v: 1, key: "k1", iv: [...iv], cipher: [...bytes] });
  const endpointHash = createHash("sha256").update(JSON.stringify(["imap-tls-v1", "imap.example.test", 993])).digest("hex");
  await h.db.prepare(`INSERT INTO normal_accounts(id,user_id,email_address,display_name,endpoint_id,endpoint_hash,username,credential_cipher,enabled,revision,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,1,1,1)`).bind(id, userId, input.emailAddress.toLowerCase(), input.displayName, input.endpointId, endpointHash, input.username, sealed, Number(input.enabled)).run();
  return sealed;
}
