import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { flagsScenario } from "./normal-flags-fixture.mjs";

let change;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "flags-protocol-"));
  const outfile = path.join(directory, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-flags.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  change = (await import(pathToFileURL(outfile))).changeImapFlags;
});
const input = { uid: 7, uidValidity: "42", flag: "\\Flagged", value: true };
async function run(scenario, command = input, beforeDispatch = async () => {}) {
  const socket = scenario.socket();
  try { return await change(socket, "Alice", "synthetic-password", command, beforeDispatch); } finally { await socket.close(); }
}
test("explicit single-UID STORE changes only the requested flag and reads the server result", async () => {
  const scenario = flagsScenario(); let dispatches = 0;
  const result = await run(scenario, input, async () => { dispatches++; assert.equal(scenario.calls.some(line => / STORE /.test(line)), false); });
  assert.equal(dispatches, 1); assert.deepEqual(result.flags, ["\\Seen", "\\Flagged"]);
  assert.equal(scenario.calls.filter(line => /UID STORE 7 \+FLAGS\.SILENT \(\\Flagged\)$/.test(line)).length, 1);
  assert.equal(scenario.calls.some(line => /EXAMINE|BODY|EXPUNGE|MOVE|APPEND|CLOSE/.test(line)), false);
  const minus = flagsScenario(); await run(minus, { ...input, flag: "\\Seen", value: false });
  assert.ok(minus.calls.some(line => /UID STORE 7 -FLAGS\.SILENT \(\\Seen\)$/.test(line)));
});
test("a failed dispatch fence never sends STORE", async () => {
  const scenario = flagsScenario(); await assert.rejects(run(scenario, input, async () => { throw new Error("fence rejected"); }), /fence rejected/);
  assert.equal(scenario.calls.some(line => / STORE /.test(line)), false);
});
test("legal server keywords are preserved before and after STORE but never become writable inputs", async () => {
  const scenario = flagsScenario({ flags: ["\\Seen", "$NotJunk", "$Forwarded"] });
  assert.deepEqual((await run(scenario)).flags, ["\\Seen", "$NotJunk", "$Forwarded", "\\Flagged"]);
  const changed = flagsScenario({ flagsResponse: ({ tag, uid, reads }) => [
    `* 1 FETCH (UID ${uid} FLAGS (${reads === 1 ? "" : "\\Flagged $Forwarded"}))\r\n${tag} OK done\r\n`] });
  assert.deepEqual((await run(changed)).flags, ["\\Flagged", "$Forwarded"]);
  await assert.rejects(change({}, "Alice", "synthetic-password", { ...input, flag: "$Forwarded" }, async () => {}), error => error.code === "invalid_remote_flags_request");
});
test("expired control after a delayed database fence cannot send STORE", async () => {
  const scenario = flagsScenario(), socket = scenario.socket(); let expired = false;
  try {
    await assert.rejects(change(socket, "Alice", "synthetic-password", input, async () => { expired = true; },
      { assertActive() { if (expired) throw new Error("deadline expired"); } }), /deadline expired/);
    assert.equal(scenario.calls.some(line => / STORE /.test(line)), false);
  } finally { await socket.close(); }
});
for (const command of [{ ...input, uid: 0 }, { ...input, uid: 1.5 }, { ...input, uidValidity: "0" },
  { ...input, flag: "\\Deleted" }, { ...input, flag: "\\Seen)\r\nee9 EXPUNGE" }, { ...input, value: 1 }, { ...input, extra: true }]) {
  test(`invalid flag command fails before opening streams: ${JSON.stringify(command)}`, async () => {
    await assert.rejects(change({}, "Alice", "synthetic-password", command, async () => {}), error => error.code === "invalid_remote_flags_request");
  });
}
for (const [name, response] of [
  ["readonly", tag => `* OK [UIDVALIDITY 42] stable\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] allowed\r\n${tag} OK [READ-ONLY] done\r\n`],
  ["epoch changed", tag => `* OK [UIDVALIDITY 43] stable\r\n* OK [PERMANENTFLAGS (\\Seen \\Flagged)] allowed\r\n${tag} OK [READ-WRITE] done\r\n`],
  ["duplicate identity", tag => `* OK [UIDVALIDITY 42] a\r\n* OK [UIDVALIDITY 42] b\r\n* OK [PERMANENTFLAGS (\\Flagged)] allowed\r\n${tag} OK [READ-WRITE] done\r\n`],
  ["missing permanent flag", tag => `* OK [UIDVALIDITY 42] stable\r\n* OK [PERMANENTFLAGS (\\Seen \\*)] allowed\r\n${tag} OK [READ-WRITE] done\r\n`],
  ["UIDNOTSTICKY", tag => `* OK [UIDVALIDITY 42] stable\r\n* NO [UIDNOTSTICKY] unstable\r\n* OK [PERMANENTFLAGS (\\Flagged)] allowed\r\n${tag} OK [READ-WRITE] done\r\n`],
]) test(`SELECT refuses ${name} without dispatch`, async () => {
  const scenario = flagsScenario({ selectResponse: response }); let dispatched = false;
  await assert.rejects(run(scenario, input, async () => { dispatched = true; }));
  assert.equal(dispatched, false); assert.equal(scenario.calls.some(line => / STORE /.test(line)), false);
});
for (const [name, options, before] of [
  ["missing target", { flagsResponse: ({ tag }) => [`${tag} OK absent\r\n`] }, true],
  ["wrong UID", { flagsResponse: ({ tag }) => [`* 1 FETCH (UID 99 FLAGS ())\r\n${tag} OK done\r\n`] }, true],
  ["duplicate UID", { flagsResponse: ({ tag, uid }) => [`* 1 FETCH (UID ${uid} UID ${uid} FLAGS ())\r\n${tag} OK done\r\n`] }, true],
  ["unconfirmed STORE", { storeResponse: tag => `${tag} NO refused\r\n` }, false],
  ["ignored STORE", { ignoreStore: true }, false],
  ["missing target after STORE", { flagsResponse: ({ tag, uid, reads }) => [reads === 1 ? `* 1 FETCH (UID ${uid} FLAGS ())\r\n${tag} OK flags\r\n` : `${tag} OK absent\r\n`] }, false],
]) test(`flag operation refuses ${name} at the correct dispatch boundary`, async () => {
  let dispatched = false; const scenario = flagsScenario(options);
  await assert.rejects(run(scenario, input, async () => { dispatched = true; }));
  assert.equal(dispatched, !before);
});
