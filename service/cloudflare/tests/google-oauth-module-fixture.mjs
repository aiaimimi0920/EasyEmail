import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

assert.ok(process.env.EASYEMAIL_TEST_ROOT); await mkdir(process.env.EASYEMAIL_TEST_ROOT, { recursive: true });
const directory = await mkdtemp(path.join(process.env.EASYEMAIL_TEST_ROOT, "google-module-")), outfile = path.join(directory, "module.mjs");
await build({ stdin: { contents: "export * from './google-oauth-http'; export * from './google-oauth-config'; export * from './normal-account-input'; export * from './smtp-config-input';",
  resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "google-module.ts" }, bundle: true, outfile, format: "esm", platform: "node" });
export const module = await import(pathToFileURL(outfile));
export const config = { clientId: "synthetic.apps.googleusercontent.com", clientSecret: "synthetic-client-secret", redirectUri: "https://app.example.test/oauth/google/callback", hash: "synthetic" };
export const tokenBody = () => ({ access_token: "ya29.synthetic-access", refresh_token: "1//synthetic-refresh", token_type: "Bearer", expires_in: 3600, scope: "openid email https://mail.google.com/" });
export async function mockedFetch(work, stub) {
  const original = globalThis.fetch; globalThis.fetch = stub;
  try { return await work(); } finally { globalThis.fetch = original; }
}
