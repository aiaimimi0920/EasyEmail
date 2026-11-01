import assert from "node:assert/strict";
import { before, test } from "node:test";
import { mkdtemp, mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

let ImapWire;
before(async () => {
  assert.ok(process.env.EASYEMAIL_TEST_ROOT);
  await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
  const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "wire-")), outfile = path.join(directory, "wire.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/normal-imap-wire.ts", import.meta.url))], outfile, bundle: true, format: "esm", platform: "neutral" });
  ({ ImapWire } = await import(pathToFileURL(outfile)));
});

function wire(chunks) {
  const writes = [], encoder = new TextEncoder();
  const socket = { opened: Promise.resolve(), closed: Promise.resolve(), async close() {},
    readable: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); } }),
    writable: new WritableStream({ write(chunk) { writes.push(new TextDecoder().decode(chunk)); } }) };
  return { wire: new ImapWire(socket), writes };
}
const limited = error => error.code === "imap_response_limit";

for (const split of ["before-cr", "between-cr-lf", "one-byte-chunks"]) {
  test(`IMAP accepts exactly 8192 response bytes with ${split}`, async () => {
    const line = "* OK " + "x".repeat(8187);
    const chunks = split === "before-cr" ? [line, "\r\n"] : split === "between-cr-lf" ? [line + "\r", "\n"] : [...line, "\r", "\n"];
    const t = wire(chunks);
    try { assert.equal(await t.wire.line(), line); } finally { t.wire.release(); }
  });
}
test("IMAP rejects 8193 line bytes even when the terminator arrives later", async () => {
  const t = wire(["x".repeat(8192), "x", "\r", "\n"]);
  try { await assert.rejects(t.wire.line(), limited); } finally { t.wire.release(); }
});

for (const overflow of [false, true]) {
  test(`IMAP cumulative response bound ${overflow ? "rejects byte 65537" : "accepts exactly 65536 bytes"}`, async () => {
    const line = "x".repeat(8190) + "\r\n", chunks = Array(8).fill(line);
    if (overflow) chunks[7] += "x";
    const t = wire(chunks);
    try {
      for (let index = 0; index < 7; index++) assert.equal((await t.wire.line()).length, 8190);
      if (overflow) await assert.rejects(t.wire.line(), limited);
      else assert.equal((await t.wire.line()).length, 8190);
    } finally { t.wire.release(); }
  });
}

for (const overflow of [false, true]) {
  test(`IMAP command response bound ${overflow ? "rejects 101 rows" : "accepts 100 rows including completion"}`, async () => {
    const t = wire([...Array(overflow ? 100 : 99).fill("* OK bounded\r\n"), "ee1 OK completed\r\n"]);
    try {
      if (overflow) await assert.rejects(t.wire.command("NOOP"), limited);
      else assert.equal((await t.wire.command("NOOP")).length, 99);
      assert.deepEqual(t.writes, ["ee1 NOOP\r\n"]);
    } finally { t.wire.release(); }
  });
}
test("IMAP rejects repeated authentication challenges without transmitting the secret twice", async () => {
  const t = wire(["+ \r\n+ \r\nee1 OK done\r\n"]);
  try {
    await assert.rejects(t.wire.command("AUTHENTICATE PLAIN", "synthetic-base64"), error => error.code === "imap_protocol_invalid");
    assert.deepEqual(t.writes, ["ee1 AUTHENTICATE PLAIN\r\n", "synthetic-base64\r\n"]);
  } finally { t.wire.release(); }
});
