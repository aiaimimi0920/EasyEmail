import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { folderScenario, folderRows } from "./normal-folders-fixture.mjs";

let discover;
before(async () => {
  await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const root = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "folder-protocol-")), outfile = path.join(root, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-folders.ts", import.meta.url))], outfile, bundle: true, platform: "neutral", format: "esm" });
  discover = (await import(pathToFileURL(outfile))).discoverImapFolders;
});
async function run(options = {}) {
  const calls = [], scenario = folderScenario(options); let controller;
  const socket = { opened: Promise.resolve(), closed: Promise.resolve(),
    readable: new ReadableStream({ start(value) { controller = value; controller.enqueue(new TextEncoder().encode("* OK synthetic ready\r\n")); } }),
    writable: new WritableStream({ write(bytes) {
      const line = new TextDecoder().decode(bytes).replace(/\r\n$/, ""); calls.push(line);
      for (const part of scenario.handle(line)) {
        const data = typeof part === "string" ? new TextEncoder().encode(part) : part;
        for (let offset = 0; offset < data.length; offset += 2) controller.enqueue(data.slice(offset, offset + 2));
      }
    } }), close() { controller.close(); return Promise.resolve(); } };
  try { return { result: await discover(socket, "Alice", "synthetic-password"), calls }; } finally { await socket.close(); }
}
test("LIST discovers exact names, NIL delimiters, modified UTF-7, literals and server-declared roles without selecting mail", async () => {
  const { result, calls } = await run();
  assert.deepEqual(result.folders.map(row => row.name), ["INBOX", "Spam", "Projects", "中文", "Literal!"]);
  assert.equal(result.folders[2].selectable, false); assert.equal(result.folders[3].delimiter, null);
  assert.deepEqual(result.folders[1].roles, ["junk"]); assert.deepEqual(result.folders[3].roles, ["sent"]);
  assert.equal(result.folders[3].wireName, "&Ti1lhw-");
  assert.ok(calls.some(line => / LIST "" "\*"$/.test(line)));
  assert.equal(calls.some(line => /SELECT|EXAMINE|FETCH|STORE|MOVE|EXPUNGE|CREATE|DELETE/.test(line)), false);
});
test("SPECIAL-USE is requested only when advertised; unknown attributes and escaped names stay data", async () => {
  const { result, calls } = await run({ specialUse: true, rows: ['* LIST (\\VendorFlag) "." "A\\\"B\\\\C &-"\r\n'] });
  assert.ok(calls.some(line => / LIST "" "\*" RETURN \(SPECIAL-USE\)$/.test(line)));
  assert.equal(result.folders[0].name, 'A"B\\C &'); assert.deepEqual(result.folders[0].roles, []);
});
for (const [name, rows] of [
  ["duplicate INBOX case aliases", [folderRows[0], '* LIST () "/" inbox\r\n']],
  ["malformed modified UTF-7", ['* LIST () "/" "&broken-"\r\n']],
  ["encoded printable ASCII", ['* LIST () "/" "&AEE-"\r\n']],
  ["unpaired surrogate", ['* LIST () "/" "&2AA-"\r\n']],
  ["literal with trailing injection", ['* LIST () "/" {5}\r\nHello injected\r\n']],
  ["non-ASCII rev1 wire name", ['* LIST () "/" "中文"\r\n']],
  ["empty mailbox", ['* LIST () NIL ""\r\n']],
  ["multi-character delimiter", ['* LIST () "//" INBOX\r\n']],
  ["unsolicited invalid response", ['* WHAT private-response\r\n']],
  ["over-limit catalog", Array.from({ length: 129 }, (_, n) => `* LIST () "/" folder${n}\r\n`)],
]) test(`discovery refuses ${name} rather than publishing a partial catalog`, async () => {
  await assert.rejects(run({ rows }), error => /^imap_(?:protocol_invalid|response_limit|folder_name_invalid|folder_catalog_limit)$/.test(error.code));
});
test("a failed LIST never becomes a successful empty catalog", async () => {
  await assert.rejects(run({ response: tag => [`${tag} NO private refusal\r\n`] }), error => error.code === "imap_command_failed");
  assert.deepEqual((await run({ rows: [] })).result.folders, []);
});
