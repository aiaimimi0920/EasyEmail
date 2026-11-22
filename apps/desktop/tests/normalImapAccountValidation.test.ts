import assert from "node:assert/strict";
import test from "node:test";

import {
  validateNormalImapAccount,
  type NormalImapAccountFields,
} from "../src/app/normalImapAccountValidation.ts";

const validFields: NormalImapAccountFields = {
  displayName: " Work ",
  emailAddress: " USER@Example.COM ",
  imapHost: " imap.example.com ",
  imapPort: "993",
  imapSecurity: "tls",
  imapUsername: " ",
  imapPassword: "authorization-secret",
};

test("normalizes a valid manual IMAP account without changing its secret", () => {
  assert.deepEqual(validateNormalImapAccount(validFields), {
    ok: true,
    request: {
      display_name: "Work",
      email_address: "user@example.com",
      imap_host: "imap.example.com",
      imap_port: 993,
      imap_security: "tls",
      imap_username: "user@example.com",
      imap_password: "authorization-secret",
    },
  });
});

test("rejects invalid manual IMAP fields before credentials or HTTP are used", () => {
  for (const [field, value, code] of [
    ["displayName", " ", "NORMAL_IMAP_DISPLAY_NAME_REQUIRED"],
    ["emailAddress", "not-an-email", "NORMAL_IMAP_EMAIL_INVALID"],
    ["imapHost", " ", "NORMAL_IMAP_HOST_REQUIRED"],
    ["imapPort", "0", "NORMAL_IMAP_PORT_INVALID"],
    ["imapPort", "65536", "NORMAL_IMAP_PORT_INVALID"],
    ["imapPort", "993x", "NORMAL_IMAP_PORT_INVALID"],
    ["imapPassword", " ", "NORMAL_IMAP_AUTHORIZATION_REQUIRED"],
  ] as const) {
    const result = validateNormalImapAccount({ ...validFields, [field]: value });
    assert.equal(result.ok, false, `${field}=${JSON.stringify(value)}`);
    if (!result.ok) assert.equal(result.error.code, code);
  }
});
