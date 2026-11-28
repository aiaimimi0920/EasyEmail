import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

async function loadReaderDocumentBuilder() {
  const dir = await mkdtemp(join(tmpdir(), "ee-desktop-reader-test-"));
  const outfile = join(dir, "safeMailReaderDocument.mjs");
  const entry = fileURLToPath(new URL("../src/mail/safeMailReaderDocument.ts", import.meta.url));
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
  });
  const mod = await import(pathToFileURL(outfile).href) as {
    buildDesktopMailFrameSrcDoc: (rawHtml: string) => string;
  };
  return { buildDesktopMailFrameSrcDoc: mod.buildDesktopMailFrameSrcDoc, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("Desktop primary reading frame wraps raw HTML in a CSP-locked light-paper sandbox and blocks remote images", async () => {
  const { buildDesktopMailFrameSrcDoc, cleanup } = await loadReaderDocumentBuilder();
  try {
    const srcDoc = buildDesktopMailFrameSrcDoc(
      '<style>.card { color: #223344; }</style><div class="card"><script>evil()</script>' +
        '<img src="https://cdn.example/banner.png" width="300" height="120" alt="Banner" />' +
        '<img src="https://track.example/open.gif" width="1" height="1" />' +
        '<img src="data:image/png;base64,iVBORw0KGgo=" alt="Inline" /></div>',
    );

    assert.match(srcDoc, /Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none';"/);
    assert.match(srcDoc, /class="ee-mail-root" data-ee-reader-scheme="paper-light"/);
    assert.match(srcDoc, /\.ee-mail-root \.card/);
    assert.doesNotMatch(srcDoc, /<script|evil\(\)/);
    assert.match(srcDoc, /data-ee-remote-src="https:\/\/cdn\.example\/banner\.png"/);
    assert.match(srcDoc, /data-ee-tracking-blocked="1"/);
    assert.match(srcDoc, /src="data:image\/png;base64,iVBORw0KGgo="/);
    assert.doesNotMatch(srcDoc, /\ssrc="https:/);
  } finally {
    await cleanup();
  }
});

test("Desktop primary reading frame preserves remote-image markers on already-sanitized DB HTML", async () => {
  const { buildDesktopMailFrameSrcDoc, cleanup } = await loadReaderDocumentBuilder();
  try {
    const preSanitized =
      '<style>.ee-mail-root .card { color: #123456; }</style>' +
      '<div class="card"><img data-ee-remote-src="https://cdn.example/photo.jpg" alt="Photo" /></div>';

    const srcDoc = buildDesktopMailFrameSrcDoc(preSanitized);
    assert.match(srcDoc, /data-ee-remote-src="https:\/\/cdn\.example\/photo\.jpg"/);
    assert.match(srcDoc, /\.ee-mail-root \.card/);
  } finally {
    await cleanup();
  }
});

test("Desktop primary reading frame blocks unbalanced-quote, protocol-relative, and CSS remote images", async () => {
  const { buildDesktopMailFrameSrcDoc, cleanup } = await loadReaderDocumentBuilder();
  try {
    const srcDoc = buildDesktopMailFrameSrcDoc(
      '<style>.hero{background:url(https://cdn.example/css.png)}</style>' +
        '<table background="https://cdn.example/table.png"><tr>' +
        '<td style="background-image:url(https://cdn.example/cell.png)">' +
        '<img src="https://cdn.example/leak.png" alt="unclosed>' +
        '<img src="//cdn.example/proto.png" alt="Proto" />' +
        "</td></tr></table>",
    );
    assert.match(srcDoc, /img-src data: blob:;/);
    assert.doesNotMatch(srcDoc, /\ssrc="https?:/i);
    assert.doesNotMatch(srcDoc, /\ssrc="\/\//i);
    assert.doesNotMatch(srcDoc, /url\([^)]*https?:/i);
    assert.match(srcDoc, /data-ee-remote-src="https:\/\/cdn\.example\/leak\.png"/);
    assert.match(srcDoc, /data-ee-remote-src="https:\/\/cdn\.example\/proto\.png"/);
  } finally {
    await cleanup();
  }
});

test("MailReadingPane primary HTML iframes enforce buildDesktopMailFrameSrcDoc and no-referrer", async () => {
  const panePath = fileURLToPath(new URL("../src/components/app/MailReadingPane.tsx", import.meta.url));
  const source = await readFile(panePath, "utf8");
  const srcDocMatches = source.match(/srcDoc=\{buildDesktopMailFrameSrcDoc\(/g) ?? [];
  const referrerMatches = source.match(/referrerPolicy="no-referrer"/g) ?? [];
  assert.equal(srcDocMatches.length, 2);
  assert.equal(referrerMatches.length, 2);
});
