import assert from "node:assert/strict";
import test from "node:test";

import { collectPreviewAssets } from "../scripts/verify-preview-http.mjs";

test("collects every script, stylesheet, and module preload regardless of attribute order", () => {
  const html = `
    <link href='/assets/react-vendor.js' crossorigin rel='modulepreload'>
    <link rel="stylesheet preload" href="/assets/index.css">
    <script defer src='/assets/index.js' type='module'></script>
    <script type="module" src="/assets/secondary.js"></script>
  `;

  assert.deepEqual(collectPreviewAssets(html), [
    { reference: "/assets/react-vendor.js", kind: "javascript" },
    { reference: "/assets/index.css", kind: "stylesheet" },
    { reference: "/assets/index.js", kind: "javascript" },
    { reference: "/assets/secondary.js", kind: "javascript" },
  ]);
});

test("ignores unrelated links and deduplicates repeated module assets", () => {
  const html = `
    <link rel="icon" href="/favicon.svg">
    <link rel="preconnect" href="https://example.com">
    <link rel="modulepreload" href="/assets/vendor.js">
    <script src="/assets/vendor.js"></script>
    <script>console.log("inline")</script>
  `;

  assert.deepEqual(collectPreviewAssets(html), [
    { reference: "/assets/vendor.js", kind: "javascript" },
  ]);
});
