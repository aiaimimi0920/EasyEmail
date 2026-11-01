import assert from "node:assert/strict";
import { test, before } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";
let inspect, vault;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "imap-wire-")), outfile = path.join(directory, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-protocol.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  inspect = (await import(pathToFileURL(outfile))).inspectImapInbox;
  const vaultFile = path.join(directory, "vault.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/mailbox-vault.ts", import.meta.url))], outfile: vaultFile, bundle: true, format: "esm", platform: "neutral" });
  vault = await import(pathToFileURL(vaultFile));
});
function socket(lines) {
  const writes = [], bytes = new TextEncoder().encode(lines.join("\r\n") + "\r\n");
  return { writes, opened: Promise.resolve(), closed: Promise.resolve(), async close() {},
    readable: new ReadableStream({ start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); } }),
    writable: new WritableStream({ write(value) { writes.push(new TextDecoder().decode(value)); } }) };
}
const valid = ["* OK ready", "* CAPABILITY IMAP4rev1 AUTH=PLAIN", "ee1 OK done", "+ ", "ee2 OK done", "* 0 EXISTS", "* OK [UIDVALIDITY 4294967295] stable", "ee3 OK [READ-ONLY] done"];
test("ordinary credential purpose cannot collide with legacy mailbox AAD even at identical IDs and provider names", async () => {
  const env = { MAILBOX_KEYRING: JSON.stringify({ active: "k1", keys: { k1: "c5".repeat(32) } }) };
  const legacy = { id: "same-id", user_id: "same-user", provider_id: "normal-imap-v1" }, normal = { ...legacy, purpose: "ee-normal-account-v1" };
  const sealed = await vault.encryptCredential(env, legacy, { token: "synthetic-secret" });
  assert.deepEqual(await vault.decryptCredential(env, legacy, sealed), { token: "synthetic-secret" });
  await assert.rejects(vault.decryptCredential(env, normal, sealed), error => error.code === "mailbox_credential_unavailable");
  const parsed = JSON.parse(sealed), key = await crypto.subtle.importKey("raw", Uint8Array.from({ length: 32 }, () => 197), "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(parsed.iv),
    additionalData: new TextEncoder().encode(JSON.stringify(["ee-mailbox-v1", legacy.id, legacy.user_id, legacy.provider_id])) }, key, new Uint8Array(parsed.cipher));
  assert.deepEqual(JSON.parse(new TextDecoder().decode(plain)), { token: "synthetic-secret" }, "Legacy serialized AAD is byte compatible");
  assert.notEqual(await vault.credentialRequestHash(env, legacy, "same-secret-request"), await vault.credentialRequestHash(env, normal, "same-secret-request"));
});
test("read-only protocol accepts zero messages and maximum UIDVALIDITY without emitting message mutations", async () => {
  const s = socket(valid), result = await inspect(s, "用户", "密码");
  assert.deepEqual(result.inbox, { path: "INBOX", uidValidity: "4294967295", messages: 0 });
  assert.equal(Buffer.from(s.writes[2].trim(), "base64").toString(), "\0用户\0密码");
  assert.equal(s.writes.some(line => /SELECT|FETCH|STORE|MOVE|EXPUNGE/.test(line)), false);
});
for (const [name, mutate, code] of [
  ["unsolicited auth success", rows => rows.filter(line => line !== "+ "), "imap_protocol_invalid"],
  ["literal smuggling", rows => ["* OK {99}", ...rows.slice(1)], "imap_protocol_invalid"],
  ["bare LF", rows => ["* OK ready\nforged", ...rows.slice(1)], "imap_protocol_invalid"],
  ["oversized line", rows => ["* OK " + "x".repeat(9000), ...rows.slice(1)], "imap_response_limit"],
  ["server BYE", rows => ["* BYE closed", ...rows.slice(1)], "imap_greeting_invalid"],
  ["tag mismatch", rows => rows.map(line => line === "ee1 OK done" ? "other OK done" : line), "imap_connection_closed"],
  ["overflow identity", rows => rows.map(line => line.replace("4294967295", "4294967296")), "imap_inbox_identity_missing"],
  ["duplicate UIDVALIDITY", rows => [...rows.slice(0, -1), "* OK [UIDVALIDITY 7] ambiguous", rows.at(-1)], "imap_inbox_identity_missing"],
  ["duplicate EXISTS", rows => [...rows.slice(0, -1), "* 1 EXISTS", rows.at(-1)], "imap_inbox_identity_missing"],
  ["invalid extra UIDVALIDITY", rows => [...rows.slice(0, -1), "* OK [UIDVALIDITY 0] invalid", rows.at(-1)], "imap_inbox_identity_missing"],
  ["missing READ-ONLY", rows => rows.map(line => line.replace("[READ-ONLY] ", "")), "imap_not_read_only"],
  ["READ-WRITE EXAMINE", rows => rows.map(line => line.replace("READ-ONLY", "READ-WRITE")), "imap_not_read_only"],
  ["unsupported auth", rows => rows.map(line => line.replace("AUTH=PLAIN", "AUTH=XOAUTH2")), "imap_auth_method_unavailable"],
  ["auth rejection", rows => rows.map(line => line === "ee2 OK done" ? "ee2 NO sensitive reason" : line), "imap_auth_failed"],
]) {
  test(`IMAP discovery refuses ${name} with a sanitized code`, async () => {
    const s = socket(mutate([...valid]));
    await assert.rejects(inspect(s, "Alice", "sensitive-password"), error => error.code === code && !error.message.includes("sensitive"));
  });
}
