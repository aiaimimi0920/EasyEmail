import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { folderFlagsScenario } from "./normal-folder-flags-fixture.mjs";
import { mailboxData } from "./normal-folder-inbox-fixture.mjs";

let change;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "folder-flags-protocol-")), outfile = path.join(directory, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-flags.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  change = (await import(pathToFileURL(outfile))).changeImapFlags;
});
const input = { uid: 2, uidValidity: "42", flag: "\\Flagged", value: true };
for (const name of ["Sent", "&Ti1lhw-", 'Projects/"quoted"\\leaf']) test(`trusted wire mailbox is quoted and isolated: ${name}`, async () => {
  const mailboxes = mailboxData(); mailboxes.set(name, mailboxes.get("Sent")); const scenario = folderFlagsScenario({ mailboxes }), socket = scenario.socket();
  try {
    assert.deepEqual((await change(socket, "Alice", "synthetic-password", input, async () => {}, undefined, name)).flags, ["\\Seen", "\\Flagged"]);
    assert.deepEqual(scenario.stores, [{ name, uid: 2, flag: "\\Flagged", value: true }]); assert.deepEqual(scenario.flags("INBOX", 2), ["\\Seen"]);
    assert.equal(scenario.calls.filter(line => line.includes(" SELECT ")).length, 1);
    assert.equal(scenario.calls.some(line => /MOVE|EXPUNGE|COPY|APPEND|BODY|EXAMINE/.test(line)), false);
  } finally { await socket.close(); }
});
for (const name of ["", "Sent\r\nee2 EXPUNGE", "中文", "&invalid", "&AAo-"]) test(`invalid trusted mailbox fails before opening streams: ${JSON.stringify(name)}`, async () => {
  await assert.rejects(change({}, "Alice", "synthetic-password", input, async () => {}, undefined, name), error => error.code === "imap_folder_name_invalid");
});
