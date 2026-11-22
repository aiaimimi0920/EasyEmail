import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { mutationScenario } from "./normal-mutation-protocol-fixture.mjs";

let mutate;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mutation-boundaries-")), outfile = path.join(directory, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-mutations.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  mutate = (await import(pathToFileURL(outfile))).mutateImapMessage;
});
const command = { uid: 2, uidValidity: "42", action: "move" };
async function run(scenario, input = command, fence = async () => {}, control) {
  const socket = scenario.socket();
  try { return await mutate(socket, "Alice", "synthetic-password", input, fence, control, "Sent", input.action === "move" ? "INBOX" : undefined); }
  finally { await socket.close(); }
}
const writes = scenario => scenario.calls.filter(line => / UID (?:MOVE|COPY|STORE|EXPUNGE) /.test(line));
const selected = (tag, validity = "* OK [UIDVALIDITY 42] stable\r\n", flags = "\\Deleted", mode = "READ-WRITE") =>
  `${validity}* OK [PERMANENTFLAGS (${flags})] allowed\r\n${tag} OK [${mode}] selected\r\n`;
for (const [name, selectResponse, code] of [
  ["changed source epoch", tag => selected(tag, "* OK [UIDVALIDITY 43] changed\r\n"), "imap_mutation_epoch_changed"],
  ["missing source epoch", tag => selected(tag, ""), "imap_mutation_epoch_changed"],
  ["duplicate source epoch", tag => selected(tag, "* OK [UIDVALIDITY 42]\r\n* OK [UIDVALIDITY 42]\r\n"), "imap_mutation_epoch_changed"],
  ["out of range source epoch", tag => selected(tag, "* OK [UIDVALIDITY 4294967296]\r\n"), "imap_mutation_epoch_changed"],
  ["nonsticky source", tag => selected(tag, "* OK [UIDVALIDITY 42]\r\n* OK [UIDNOTSTICKY]\r\n"), "imap_uids_not_sticky"],
  ["readonly source", tag => selected(tag, undefined, undefined, "READ-ONLY"), "imap_mutation_read_only"],
  ["nonpermanent Deleted", tag => selected(tag, undefined, "\\Seen \\Flagged"), "imap_mutation_delete_not_permanent"],
]) test(`fallback refuses ${name} before every remote write`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", selectResponse }); let dispatched = false;
  await assert.rejects(run(scenario, command, async () => { dispatched = true; }), error => error.code === code);
  assert.equal(dispatched, false); assert.deepEqual(writes(scenario), []);
});
for (const [name, response, code] of [
  ["missing epoch", tag => `${tag} OK [READ-ONLY] selected\r\n`, "imap_mutation_epoch_changed"],
  ["duplicate epoch", tag => `* OK [UIDVALIDITY 42]\r\n* OK [UIDVALIDITY 42]\r\n${tag} OK [READ-ONLY] selected\r\n`, "imap_mutation_epoch_changed"],
  ["nonsticky", tag => `* OK [UIDVALIDITY 42]\r\n* OK [UIDNOTSTICKY]\r\n${tag} OK [READ-ONLY] selected\r\n`, "imap_uids_not_sticky"],
]) test(`destination EXAMINE ${name} fails before SELECT or side effects`, async () => {
  const scenario = mutationScenario({ examineResponse: response });
  await assert.rejects(run(scenario), error => error.code === code);
  assert.deepEqual(writes(scenario), []); assert.equal(scenario.calls.some(line => / SELECT /.test(line)), false);
});
test("IMAP4rev2 includes native UID MOVE and does not require permanent Deleted for a move", async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev2 AUTH=PLAIN", selectResponse: tag => selected(tag, undefined, "\\Seen") });
  assert.equal((await run(scenario)).method, "move"); assert.equal(writes(scenario).length, 1);
  assert.match(writes(scenario)[0], / UID MOVE 2 INBOX$/);
});
test("IMAP4rev2 permits exact UID EXPUNGE for explicit delete while protecting unrelated Deleted", async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev2 AUTH=PLAIN" });
  scenario.deleted.add("Sent:999"); scenario.mailboxes.get("Sent").messages.set(999, new Uint8Array([1]));
  assert.equal((await run(scenario, { ...command, action: "delete" })).method, "delete");
  assert.ok(scenario.mailboxes.get("Sent").messages.has(999)); assert.equal(writes(scenario).length, 2);
});
for (const native of [false, true]) test(`missing COPYUID after ${native ? "MOVE" : "COPY"} preserves partial effects but never retries`, async () => {
  const scenario = mutationScenario({ capabilities: `IMAP4rev1 AUTH=PLAIN UIDPLUS${native ? " MOVE" : ""}`,
    copyResponse: ({ tag }) => `${tag} OK accepted\r\n` });
  await assert.rejects(run(scenario), error => error.code === "imap_mutation_mapping_unconfirmed");
  assert.ok(scenario.mailboxes.get("INBOX").messages.has(501)); assert.equal(scenario.mailboxes.get("Sent").messages.has(2), !native);
  assert.equal(writes(scenario).length, 1);
});
for (const [stage, options, count] of [
  ["STORE", { storeResponse: tag => `${tag} NO refused after effect\r\n` }, 1],
  ["UID EXPUNGE", { expungeResponse: tag => `${tag} NO refused after effect\r\n` }, 2],
]) test(`${stage} response failure after effect cannot cause automatic replay or compensation`, async () => {
  const scenario = mutationScenario(options);
  await assert.rejects(run(scenario, { ...command, action: "delete" }));
  assert.equal(writes(scenario).length, count); assert.ok(scenario.deleted.has("Sent:2"));
  assert.equal(scenario.mailboxes.get("Sent").messages.has(2), stage === "STORE");
});
for (const phase of ["copy", "mark-deleted", "expunge"]) test(`deadline revoked immediately after ${phase} fence prevents its command`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" }); let active = true;
  await assert.rejects(run(scenario, command, async value => { if (value === phase) active = false; }, {
    assertActive() { if (!active) throw new Error("synthetic deadline"); },
  }), /synthetic deadline/);
  assert.equal(writes(scenario).length, ["copy", "mark-deleted", "expunge"].indexOf(phase));
});
test("COPYUID equal singleton ranges are accepted without treating a range as multiple messages", async () => {
  const scenario = mutationScenario({ copyResponse: ({ tag }) => `${tag} OK [COPYUID 42 2:2 501:501] copied\r\n` });
  assert.deepEqual((await run(scenario)).destination, { uidValidity: "42", uid: 501 });
});
for (const target of ["0", "4294967296", "0501", "501:500", "501:502"]) test(`COPYUID invalid singleton ${target} never authorizes source deletion`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS",
    copyResponse: ({ tag }) => `${tag} OK [COPYUID 42 2 ${target}] copied\r\n` });
  await assert.rejects(run(scenario), error => error.code === "imap_mutation_mapping_unconfirmed");
  assert.equal(writes(scenario).length, 1); assert.ok(scenario.mailboxes.get("Sent").messages.has(2));
});
