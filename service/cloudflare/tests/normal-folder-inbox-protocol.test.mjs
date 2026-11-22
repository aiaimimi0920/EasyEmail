import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { readScenario } from "./normal-read-fixture.mjs";

let read;
before(async () => {
  await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "folder-read-")), outfile = path.join(directory, "read.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-read.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  read = (await import(pathToFileURL(outfile))).readImapBatch;
});
for (const [wireName, expected] of [["INBOX", "INBOX"], ["Sent", '"Sent"'], ["&Ti1lhw-", '"&Ti1lhw-"'], ['A"B\\C &-', '"A\\"B\\\\C &-"']]) {
  test(`EXAMINE selects exact quoted folder ${wireName} without writable selection`, async () => {
    const peer = readScenario({ chunkSize: 1 }), socket = peer.socket();
    try {
      const result = await read(socket, "Alice", "synthetic-password", null, undefined, wireName);
      assert.equal(result.inbox.path, wireName); assert.ok(peer.calls.some(line => line.endsWith(` EXAMINE ${expected}`)));
      assert.equal(peer.calls.some(line => / SELECT | STORE | MOVE | EXPUNGE/.test(line)), false);
    } finally { await socket.close(); }
  });
}
test("invalid folder names fail before touching socket streams", async () => {
  for (const name of ["", "Sent\r\nee99 SELECT INBOX", "中文", "&broken-"]) {
    await assert.rejects(read({}, "Alice", "synthetic-password", null, undefined, name), error => error.code === "imap_folder_name_invalid");
  }
});
