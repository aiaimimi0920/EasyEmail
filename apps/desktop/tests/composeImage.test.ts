import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPOSE_IMAGE_MAX_BYTES,
  buildComposeImageHtml,
  escapeHtmlAttribute,
  validateComposeImageFile,
} from "../src/compose/composeImage.ts";

test("compose image validation accepts bounded images", () => {
  assert.deepEqual(validateComposeImageFile({ type: "image/png", size: 1024 }), { valid: true });
});

test("compose image validation rejects non-images, empty files, and oversized images", () => {
  assert.equal(validateComposeImageFile({ type: "text/html", size: 1024 }).valid, false);
  assert.equal(validateComposeImageFile({ type: "image/svg+xml", size: 1024 }).valid, false);
  assert.equal(validateComposeImageFile({ type: "image/png", size: 0 }).valid, false);
  assert.equal(
    validateComposeImageFile({ type: "image/jpeg", size: COMPOSE_IMAGE_MAX_BYTES + 1 }).valid,
    false,
  );
});

test("compose image HTML escapes file names and attribute values", () => {
  assert.equal(escapeHtmlAttribute(`a&b"c'd<e>`), "a&amp;b&quot;c&#39;d&lt;e&gt;");
  assert.equal(
    buildComposeImageHtml("data:image/png;base64,abc", `avatar\" onerror=\"alert(1)`),
    '<img src="data:image/png;base64,abc" alt="avatar&quot; onerror=&quot;alert(1)" />',
  );
});
