import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { preview } from "vite";

const host = "127.0.0.1";

function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2] ?? null;
}

export function collectPreviewAssets(html) {
  const assets = new Map();
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const [, element] = match;
    const tag = match[0];
    if (element.toLowerCase() === "script") {
      const source = attributeValue(tag, "src");
      if (source) assets.set(source, "javascript");
      continue;
    }

    const reference = attributeValue(tag, "href");
    const relations = (attributeValue(tag, "rel") ?? "").toLowerCase().split(/\s+/);
    if (reference && relations.includes("modulepreload")) {
      assets.set(reference, "javascript");
    } else if (reference && relations.includes("stylesheet")) {
      assets.set(reference, "stylesheet");
    }
  }
  return Array.from(assets, ([reference, kind]) => ({ reference, kind }));
}

async function reservePreviewPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (!address || typeof address === "string") {
        probe.close();
        reject(new Error("Could not reserve a preview port."));
        return;
      }
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

export async function verifyPreviewHttp() {
  const port = await reservePreviewPort();
  const baseUrl = `http://${host}:${port}`;
  const server = await preview({
    preview: { host, port, strictPort: true },
  });

  try {
    const response = await fetch(baseUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/);
    const html = await response.text();
    assert.match(html, /<div id="root"><\/div>/);

    const assets = collectPreviewAssets(html);
    assert.ok(
      assets.some((asset) => asset.kind === "javascript"),
      "Production HTML must load a JavaScript entry.",
    );
    assert.ok(
      assets.some((asset) => asset.kind === "stylesheet"),
      "Production HTML must load a stylesheet.",
    );
    await Promise.all(assets.map(async (asset) => {
      const assetResponse = await fetch(new URL(asset.reference, `${baseUrl}/`));
      assert.equal(assetResponse.status, 200, `${asset.reference} must be available.`);
      const expectedContentType = asset.kind === "javascript" ? /javascript/ : /text\/css/;
      assert.match(
        assetResponse.headers.get("content-type") ?? "",
        expectedContentType,
        `${asset.reference} must have the expected content type.`,
      );
      await assetResponse.arrayBuffer();
    }));

    const sourceHtml = await readFile("dist/index.html", "utf8");
    assert.equal(html, sourceHtml);
    console.log(`Production preview HTTP smoke passed (${assets.length} assets).`);
  } finally {
    await server.close();
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;
if (invokedPath === import.meta.url) {
  await verifyPreviewHttp();
}
