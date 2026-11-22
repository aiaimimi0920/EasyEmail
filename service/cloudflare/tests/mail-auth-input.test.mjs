import assert from "node:assert/strict";
import { test } from "node:test";
import { invoke, socketHook, token } from "./mail-auth-module-fixture.mjs";

const invalid = [null, {}, { method: "PLAIN", accessToken: token }, { method: "xoauth2" }, { method: "xoauth2", accessToken: "" },
  { method: "xoauth2", accessToken: token, password: "do-not-fallback" }, { method: "xoauth2", accessToken: 42 },
  ...["\r\nAUTH PLAIN", "\x01auth=Bearer leaked", "white space", "用户", "\ud800", "=" + token, "a=b", "a".repeat(4097)]
    .map(accessToken => ({ method: "xoauth2", accessToken }))];
for (const protocol of ["imap", "smtp"]) test(`${protocol} invalid authentication fails before opening a socket without leaking credentials`, async () => {
  let opens = 0; globalThis[socketHook] = () => { opens++; throw new Error("must not connect"); };
  for (const value of invalid) {
    if (protocol === "imap") await assert.rejects(invoke(protocol, "tls", value), { code: "invalid_mail_authentication" });
    else assert.deepEqual(await invoke(protocol, "tls", value), { state: "rejected", error: "invalid_mail_authentication" });
  }
  assert.equal(opens, 0);
});
for (const protocol of ["imap", "smtp"]) test(`${protocol} control/injection or non-roundtripping usernames fail before socket ownership`, async () => {
  let opens = 0; globalThis[socketHook] = () => { opens++; throw new Error("must not connect"); };
  for (const username of ["", "a\x01auth=Bearer x", "a\r\nMAIL FROM:<x>", "\0", "\ud800", "x".repeat(256)]) {
    const pending = invoke(protocol, "tls", { method: "xoauth2", accessToken: token }, false, username);
    if (protocol === "imap") await assert.rejects(pending, { code: "invalid_mail_authentication" });
    else assert.deepEqual(await pending, { state: "rejected", error: "invalid_mail_authentication" });
  }
  assert.equal(opens, 0);
});
