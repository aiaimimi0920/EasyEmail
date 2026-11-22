import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

export const socketHook = Symbol.for("easyemail-test-mail-auth-connect");
assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "mail-auth-")), outfile = path.join(directory, "clients.mjs");
await build({ stdin: { contents: "export * from './normal-imap-client'; export * from './smtp-client';",
  resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "mail-auth-clients.ts" },
  bundle: true, outfile, format: "esm", platform: "node", plugins: [{ name: "synthetic-mail-auth", setup(b) {
    b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: "sockets", namespace: "synthetic" }));
    b.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: `export function connect(a,o){return globalThis[Symbol.for('easyemail-test-mail-auth-connect')](a,o);}` }));
  } }] });
export const runtime = await import(pathToFileURL(outfile));
export const username = "alice@example.test", token = "ya29.Synthetic-_~+/accessToken==", password = "Synthetic-password-742951";
export const authentication = { method: "xoauth2", accessToken: token };
export const message = { from: username, recipients: ["receiver@example.test"], mime: "Subject: synthetic\r\n\r\nbody\r\n.\r\n" };
export function endpoint(protocol, security = "tls") {
  return { id: "example", label: "Synthetic", hostname: `${protocol}.example.test`, security,
    port: protocol === "imap" ? security === "starttls" ? 143 : 993 : security === "starttls" ? 587 : 465, recipients: ["*"] };
}
export function invoke(protocol, security = "tls", credential = authentication, read = false, login = username) {
  return protocol === "imap" ? runtime[read ? "readImapMessages" : "testImapConnection"](endpoint(protocol, security), login, credential)
    : runtime.sendSmtp(endpoint(protocol, security), login, credential, message);
}
