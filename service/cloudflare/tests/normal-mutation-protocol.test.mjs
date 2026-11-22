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
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mutation-protocol-")), outfile = path.join(directory, "protocol.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-mutations.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  mutate = (await import(pathToFileURL(outfile))).mutateImapMessage;
});
const command = { uid: 2, uidValidity: "42", action: "move" };
async function run(scenario, input = command, beforeDispatch = async () => {}, source = "Sent", destination = input.action === "move" ? "&Ti1lhw-" : undefined, control) {
  const socket = scenario.socket();
  try { return await mutate(socket, "Alice", "synthetic-password", input, beforeDispatch, control, source, destination); }
  finally { await socket.close(); }
}
const writes = calls => calls.filter(line => / UID (?:MOVE|COPY|STORE|EXPUNGE) /.test(line));
test("native UID MOVE binds exact source/destination epochs, parses COPYUID and verifies source removal", async () => {
  const scenario = mutationScenario(), phases = [];
  const result = await run(scenario, command, async phase => phases.push(phase));
  assert.deepEqual(phases, ["move"]); assert.equal(result.method, "move"); assert.equal(result.sourceRemoved, true);
  assert.deepEqual(result.destination, { uidValidity: "42", uid: 501 });
  assert.deepEqual(writes(scenario.calls).map(line => line.slice(line.indexOf(" UID ") + 1)), ['UID MOVE 2 "&Ti1lhw-"']);
  assert.ok(scenario.mailboxes.get("INBOX").messages.has(2)); assert.equal(scenario.mailboxes.get("Sent").messages.has(2), false);
  assert.ok(scenario.calls.some(line => / EXAMINE "&Ti1lhw-"$/.test(line))); assert.equal(scenario.calls.filter(line => / CAPABILITY$/.test(line)).length, 2);
});
test("observed mapping is independent of the next command and invalid observation hooks fail before streams", async () => {
  await assert.rejects(mutate({}, "Alice", "synthetic-password", command, async () => {}, undefined, "Sent", "INBOX", "invalid"),
    error => error.code === "invalid_remote_mutation_request");
  const scenario = mutationScenario({ keepSource: true }), socket = scenario.socket(), observed = [];
  try {
    await assert.rejects(mutate(socket, "Alice", "synthetic-password", command, async () => {}, undefined, "Sent", "INBOX",
      async destination => observed.push(destination)), error => error.code === "imap_mutation_unconfirmed");
    assert.deepEqual(observed, [{ uidValidity: "42", uid: 501 }]); assert.equal(writes(scenario.calls).length, 1);
  } finally { await socket.close(); }
});
test("COPY/STORE/UID EXPUNGE fallback preserves an unrelated deleted UID and fences each irreversible phase", async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" }), phases = [];
  scenario.deleted.add("Sent:999"); scenario.mailboxes.get("Sent").messages.set(999, new Uint8Array([1]));
  const result = await run(scenario, command, async phase => phases.push(phase));
  assert.equal(result.method, "copy-expunge"); assert.deepEqual(phases, ["copy", "mark-deleted", "expunge"]);
  assert.ok(scenario.mailboxes.get("Sent").messages.has(999));
  assert.deepEqual(writes(scenario.calls).map(line => line.slice(line.indexOf(" UID ") + 1)), ['UID COPY 2 "&Ti1lhw-"', "UID STORE 2 +FLAGS.SILENT (\\Deleted)", "UID EXPUNGE 2"]);
  assert.equal(scenario.calls.some(line => /^\S+ (?:EXPUNGE|CLOSE)\b/.test(line)), false);
});
test("explicit permanent delete needs UIDPLUS and verifies Deleted before exact UID EXPUNGE", async () => {
  const scenario = mutationScenario(), phases = [], result = await run(scenario, { ...command, action: "delete" }, async phase => phases.push(phase));
  assert.equal(result.method, "delete"); assert.equal(result.destination, null); assert.equal(result.sourceRemoved, true);
  assert.deepEqual(phases, ["mark-deleted", "expunge"]); assert.equal(scenario.mailboxes.get("Sent").messages.has(2), false);
});
for (const action of ["move", "delete"]) test(`${action} without safe capabilities fails before all remote writes`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN" }); let dispatched = false;
  await assert.rejects(run(scenario, { ...command, action }, async () => { dispatched = true; }), error => error.code === "imap_mutation_unsupported");
  assert.equal(dispatched, false); assert.deepEqual(writes(scenario.calls), []);
});
for (const phase of ["copy", "mark-deleted", "expunge"]) test(`revoked final fence at ${phase} never advances to that irreversible phase`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" });
  await assert.rejects(run(scenario, command, async value => { if (phase === value) throw new Error("revoked"); }), /revoked/);
  assert.equal(writes(scenario.calls).length, ["copy", "mark-deleted", "expunge"].indexOf(phase));
  assert.ok(scenario.mailboxes.get("Sent").messages.has(2));
});
for (const [name, copyResponse] of [
  ["missing", ({ tag }) => `${tag} OK accepted\r\n`],
  ["wrong source", ({ tag }) => `${tag} OK [COPYUID 42 7 501] copied\r\n`],
  ["wrong destination epoch", ({ tag }) => `${tag} OK [COPYUID 43 2 501] copied\r\n`],
  ["multiple targets", ({ tag }) => `${tag} OK [COPYUID 42 2 501,502] copied\r\n`],
  ["duplicate", ({ tag }) => `* OK [COPYUID 42 2 501]\r\n${tag} OK [COPYUID 42 2 501]\r\n`],
]) test(`ambiguous COPYUID (${name}) cannot authorize source deletion or another COPY`, async () => {
  const scenario = mutationScenario({ capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS", copyResponse });
  await assert.rejects(run(scenario), error => error.code === "imap_mutation_mapping_unconfirmed");
  assert.equal(writes(scenario.calls).length, 1); assert.ok(scenario.mailboxes.get("Sent").messages.has(2));
});
for (const options of [{ keepSource: true }, { ignoreDeleted: true, capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" }]) {
  test(`server acceptance without the required observed state is never confirmed: ${JSON.stringify(options)}`, async () => {
    const scenario = mutationScenario(options); await assert.rejects(run(scenario), error => error.code === "imap_mutation_unconfirmed");
    assert.equal(scenario.calls.filter(line => / UID COPY /.test(line)).length, options.ignoreDeleted ? 1 : 0);
    if (options.ignoreDeleted) assert.equal(scenario.calls.some(line => / UID EXPUNGE /.test(line)), false);
  });
}
test("post-auth capabilities rather than pre-auth advertisements choose the safe algorithm", async () => {
  const scenario = mutationScenario({ preAuthCapabilities: "IMAP4rev1 AUTH=PLAIN MOVE UIDPLUS", capabilities: "IMAP4rev1 AUTH=PLAIN UIDPLUS" });
  assert.equal((await run(scenario)).method, "copy-expunge");
});
for (const [input, source, destination] of [
  [{ ...command, uid: 0 }, "Sent", "INBOX"], [{ ...command, uidValidity: "0" }, "Sent", "INBOX"],
  [{ ...command, action: "copy" }, "Sent", "INBOX"], [{ ...command, extra: true }, "Sent", "INBOX"],
  [command, "Sent", "Sent"], [command, "Sent", "bad\r\nee9 EXPUNGE"], [command, "bad\nname", "INBOX"],
]) test(`invalid destructive command fails before streams: ${JSON.stringify([input, source, destination])}`, async () => {
  await assert.rejects(mutate({}, "Alice", "synthetic-password", input, async () => {}, undefined, source, destination));
});
