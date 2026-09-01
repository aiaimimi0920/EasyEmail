import assert from "node:assert/strict";
import test from "node:test";

import {
  CUSTOM_AVATAR_MAX_BYTES,
  CUSTOM_AVATAR_MAX_EDGE,
  dataUrlPayloadBytes,
  isResizableAvatarMime,
} from "../src/avatar/contactAvatarImage.ts";

test("estimates decoded data URL payload bytes including base64 padding", () => {
  assert.equal(dataUrlPayloadBytes("data:image/png;base64,YQ=="), 1);
  assert.equal(dataUrlPayloadBytes("data:image/png;base64,YWI="), 2);
  assert.equal(dataUrlPayloadBytes("data:image/png;base64,YWJj"), 3);
  assert.equal(dataUrlPayloadBytes("not-a-data-url"), "not-a-data-url".length);
});

test("limits avatar preprocessing to supported raster MIME types", () => {
  for (const mime of [
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/gif",
    "image/bmp",
    "IMAGE/PNG",
  ]) {
    assert.equal(isResizableAvatarMime(mime), true, mime);
  }

  assert.equal(isResizableAvatarMime("image/svg+xml"), false);
  assert.equal(isResizableAvatarMime("text/html"), false);
});

test("keeps the frontend avatar limits aligned with the backend contract", () => {
  assert.equal(CUSTOM_AVATAR_MAX_BYTES, 512 * 1024);
  assert.equal(CUSTOM_AVATAR_MAX_EDGE, 256);
});
