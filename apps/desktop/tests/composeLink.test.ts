import assert from "node:assert/strict";
import test from "node:test";

import { normalizeComposeLinkHref } from "../src/compose/composeLink.ts";

test("compose web links allow HTTP and HTTPS and add HTTPS when omitted", () => {
  assert.equal(normalizeComposeLinkHref("example.com/path", "web"), "https://example.com/path");
  assert.equal(normalizeComposeLinkHref("http://example.com", "web"), "http://example.com/");
  assert.equal(normalizeComposeLinkHref(" HTTPS://example.com/test ", "web"), "https://example.com/test");
});

test("compose web links reject executable and local URL schemes", () => {
  for (const value of [
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "blob:https://example.com/id",
    "vbscript:msgbox(1)",
  ]) {
    assert.equal(normalizeComposeLinkHref(value, "web"), null);
  }
});

test("compose email and phone links normalize only their expected schemes", () => {
  assert.equal(normalizeComposeLinkHref("name@example.com", "email"), "mailto:name@example.com");
  assert.equal(normalizeComposeLinkHref("MAILTO:name@example.com", "email"), "mailto:name@example.com");
  assert.equal(normalizeComposeLinkHref("+86 138 0000 0000", "phone"), "tel:+86 138 0000 0000");
  assert.equal(normalizeComposeLinkHref("tel:+12025550123", "phone"), "tel:+12025550123");
  assert.equal(normalizeComposeLinkHref("name@example.com\nBcc:other@example.com", "email"), null);
  assert.equal(normalizeComposeLinkHref("name@example.com%0d%0aBcc:other@example.com", "email"), null);
  assert.equal(normalizeComposeLinkHref("+12025550123%0A123", "phone"), null);
});
