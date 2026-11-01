import { build } from "esbuild";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const socketHook = Symbol.for("easyemail-test-starttls-connect");
const sources = ["normal-imap-client", "smtp-client", "normal-account-input", "smtp-config-input", "normal-imap-wire", "smtp-wire"];
assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "starttls-")), outfile = path.join(directory, "runtime.mjs");
await build({ stdin: { contents: sources.map(name => `export * from './${name}';`).join("\n"),
  resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "starttls-test.ts" },
  bundle: true, outfile, format: "esm", platform: "node", plugins: [{ name: "synthetic-starttls", setup(b) {
    b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: "sockets", namespace: "synthetic" }));
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: `export function connect(a,o){return globalThis[Symbol.for('easyemail-test-starttls-connect')](a,o);}` }));
  } }] });
export const runtime = await import(pathToFileURL(outfile));
export const endpoints = {
  imap: { id: "example", label: "IMAP STARTTLS", hostname: "imap.example.test", port: 143, security: "starttls" },
  smtp: { id: "example", label: "SMTP STARTTLS", hostname: "smtp.example.test", port: 587, security: "starttls", recipients: ["*"] },
};
export const message = { from: "alice@example.test", recipients: ["receiver@example.test"], mime: "Subject: synthetic\r\n\r\nbody\r\n.\r\n" };
