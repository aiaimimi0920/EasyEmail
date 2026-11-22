import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const mailCss = readFileSync(
  new URL("../src/styles/neuro-canonical-mail.css", import.meta.url),
  "utf8",
);
const focusCss = readFileSync(
  new URL("../src/styles/neuro-canonical-focus.css", import.meta.url),
  "utf8",
);

test("mail toolbar popovers keep ordinary tools on the dark semantic palette", () => {
  assert.match(
    mailCss,
    /\.nt-mail-list-toolbar__panel-search\s*\{[^}]*border-color:\s*var\(--nt-border-default\);[^}]*color:\s*var\(--nt-text-muted\);[^}]*background:\s*var\(--nt-surface-control\);/s,
  );
  assert.match(
    mailCss,
    /\.nt-mail-list-toolbar__panel-search:focus-within\s*\{[^}]*border-color:\s*var\(--nt-border-focus\);[^}]*box-shadow:\s*0 0 0 3px var\(--nt-focus-ring\);/s,
  );
  assert.match(
    mailCss,
    /\.nt-mail-list-toolbar__radio,[^}]*\.nt-mail-list-toolbar__checkbox\s*\{[^}]*border-color:\s*var\(--nt-border-default\);[^}]*color:\s*var\(--nt-action-primary-ink\);[^}]*background:\s*var\(--nt-surface-control\);/s,
  );
  assert.match(
    mailCss,
    /\.nt-mail-list-toolbar__panel-head strong,[^}]*\.nt-mail-list-toolbar__snooze-head strong\s*\{[^}]*color:\s*var\(--nt-text-primary\);/s,
  );
});

test("compose emoji controls inherit the light editing focus surface", () => {
  assert.match(
    focusCss,
    /\.nt-compose-emoji-popover\s*\{[^}]*border-color:\s*var\(--nt-reading-border\);[^}]*color:\s*var\(--nt-reading-ink\);[^}]*background:\s*var\(--nt-reading-surface\);/s,
  );
  assert.match(
    focusCss,
    /\.nt-compose-emoji-search\s*\{[^}]*border-color:\s*var\(--nt-reading-border\);[^}]*color:\s*var\(--nt-reading-muted\);[^}]*background:\s*var\(--nt-reading-control\);/s,
  );
  assert.match(
    focusCss,
    /\.nt-compose-emoji-search:focus-within\s*\{[^}]*border-color:\s*var\(--nt-border-focus\);[^}]*box-shadow:\s*0 0 0 3px var\(--nt-focus-ring\);/s,
  );
});

test("focused editing controls use semantic ink instead of legacy color literals", () => {
  assert.match(
    focusCss,
    /\.nt-compose-emoji-search input\s*\{[^}]*color:\s*var\(--nt-reading-ink\);/s,
  );
  assert.match(
    focusCss,
    /\.nt-compose-emoji-scroll\s*\{[^}]*background:\s*var\(--nt-reading-surface\);/s,
  );
  assert.match(
    focusCss,
    /\.nt-mail-taxonomy-modal__editor (?:input|select):focus-visible[^}]*\{[^}]*outline:\s*2px solid var\(--nt-border-focus\);/s,
  );
  assert.match(
    focusCss,
    /\.nt-compose-popover__send:disabled,[^}]*\.nt-mail-taxonomy-modal__primary:disabled[^}]*\{[^}]*border-color:\s*var\(--nt-disabled-border\) !important;[^}]*color:\s*var\(--nt-disabled-ink\) !important;[^}]*background:\s*var\(--nt-disabled-surface\) !important;/s,
  );
});
