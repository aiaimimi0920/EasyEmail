import assert from "node:assert/strict";
import { test } from "node:test";
import { runtime, endpoints } from "./starttls-module-fixture.mjs";

for (const protocol of ["imap", "smtp"]) test(`${protocol} explicit STARTTLS configuration and byte-compatible implicit TLS hashes`, async () => {
  const parse = runtime[`${protocol}Endpoints`], lookup = runtime[`${protocol}Endpoint`], key = `${protocol.toUpperCase()}_ENDPOINTS`;
  const legacy = { ...endpoints[protocol], port: protocol === "imap" ? 993 : 465 }; delete legacy.security;
  const prefix = protocol === "imap" ? "imap-tls-v1" : "smtp-tls-plain-v1";
  const input = [prefix, legacy.hostname, legacy.port, ...(protocol === "smtp" ? [legacy.recipients] : [])];
  const digest = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(input)))).toString("hex");
  assert.equal((await lookup({ [key]: JSON.stringify([legacy]) }, legacy.id)).hash, digest);
  assert.equal((await lookup({ [key]: JSON.stringify([{ ...legacy, security: "tls" }]) }, legacy.id)).hash, digest);
  assert.equal(parse({ [key]: JSON.stringify([endpoints[protocol]]) })[0].security, "starttls");
  assert.notEqual((await lookup({ [key]: JSON.stringify([endpoints[protocol]]) }, legacy.id)).hash, digest);
  for (const bad of [
    { ...endpoints[protocol], security: undefined }, { ...endpoints[protocol], security: "tls" },
    { ...legacy, security: "starttls" }, { ...legacy, security: "off" }, { ...legacy, port: 25 },
    { ...legacy, port: 2525 }, { ...endpoints[protocol], hostname: "127.0.0.1" },
    { ...endpoints[protocol], hostname: "host.home.arpa" }, { ...endpoints[protocol], extra: true },
  ]) assert.throws(() => parse({ [key]: JSON.stringify([bad]) }), { code: `${protocol}_endpoints_unavailable` });
});
