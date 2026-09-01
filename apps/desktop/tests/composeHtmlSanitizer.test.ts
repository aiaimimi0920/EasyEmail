import assert from "node:assert/strict";
import test from "node:test";

import { JSDOM } from "jsdom";
import { type WindowLike } from "dompurify";
import { createComposeHtmlSanitizer } from "../src/compose/composeHtmlSanitizer.ts";

function createSanitizer() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  return createComposeHtmlSanitizer(dom.window as unknown as WindowLike);
}

test("removes executable markup event handlers and unsafe links", () => {
  const sanitize = createSanitizer();
  const result = sanitize(
    '<script>alert(1)</script><svg onload="alert(1)"></svg>' +
      '<img src="x" alt="fallback" onerror="alert(1)">' +
      '<a href="javascript:alert(1)" target="_blank" onclick="alert(1)">unsafe</a>',
  );

  assert.doesNotMatch(result, /script|svg|onerror|onclick|javascript:|target=/i);
  assert.match(result, /fallback/);
  assert.match(result, /<a>unsafe<\/a>/);
});

test("preserves supported rich text while filtering style capabilities", () => {
  const sanitize = createSanitizer();
  const result = sanitize(
    '<p dir="rtl" style="color: #123456; font-size: 18px; text-align: right; position: fixed; background-image: url(https://tracker.test/pixel)">' +
      '<strong>正文</strong><br><span style="background-color: rgb(1, 2, 3)">强调</span></p>',
  );

  assert.match(result, /dir="rtl"/);
  assert.match(result, /color: rgb\(18, 52, 86\)|color: #123456/i);
  assert.match(result, /font-size: 18px/);
  assert.match(result, /text-align: right/);
  assert.match(result, /background-color: rgb\(1, 2, 3\)/);
  assert.doesNotMatch(result, /position|background-image|tracker/i);
  assert.match(result, /<strong>正文<\/strong><br>/);
});

test("keeps supported links and bounded raster data image schemes", () => {
  const sanitize = createSanitizer();
  const result = sanitize(
    '<a href="https://example.com/path" target="_blank">web</a>' +
      '<a href="mailto:name@example.com">mail</a>' +
      '<img src="data:image/png;base64,YWJj" alt="safe">' +
      '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="blocked">' +
      '<img src="https://tracker.test/pixel.png" alt="remote">',
  );

  assert.match(result, /href="https:\/\/example\.com\/path"/);
  assert.match(result, /rel="noopener noreferrer"/);
  assert.match(result, /href="mailto:name@example\.com"/);
  assert.match(result, /src="data:image\/png;base64,YWJj"/);
  assert.doesNotMatch(result, /svg\+xml|tracker\.test/);
  assert.match(result, /blocked/);
  assert.match(result, /remote/);
});

test("rejects encoded link newlines and oversized raster data URLs", () => {
  const sanitize = createSanitizer();
  const oversizedImage = `data:image/png;base64,${"A".repeat(2_796_208)}`;
  const result = sanitize(
    '<a href="mailto:name@example.com%0d%0aBcc:other@example.com">mail</a>' +
      `<img src="${oversizedImage}" alt="oversized">`,
  );

  assert.doesNotMatch(result, /href=|data:image/i);
  assert.match(result, /<a>mail<\/a>/);
  assert.match(result, /oversized/);
});

test("keeps raster data URLs at the exact two-megabyte decoded boundary", () => {
  const sanitize = createSanitizer();
  const twoMegabytePayload = `${"A".repeat(2_796_200)}AAA=`;
  const result = sanitize(
    `<img src="data:image/png;base64,${twoMegabytePayload}" alt="boundary">`,
  );

  assert.match(result, /src="data:image\/png;base64,/);
  assert.match(result, /alt="boundary"/);
});
