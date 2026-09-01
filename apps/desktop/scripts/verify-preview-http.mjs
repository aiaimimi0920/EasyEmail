import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
import { preview } from "vite";

const host = "127.0.0.1";
const port = await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, host, () => {
    const address = probe.address();
    if (!address || typeof address === "string") {
      probe.close();
      reject(new Error("Could not reserve a preview port."));
      return;
    }
    probe.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve(address.port);
      }
    });
  });
});
const baseUrl = `http://${host}:${port}`;
const server = await preview({
  preview: {
    host,
    port,
    strictPort: true,
  },
});

try {
  const response = await fetch(baseUrl);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /<div id="root"><\/div>/);
  const scriptPath = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  const stylesheetPath = html.match(/<link[^>]+href="([^"]+\.css)"/)?.[1];
  assert.ok(scriptPath, "Production HTML must load a JavaScript entry.");
  assert.ok(stylesheetPath, "Production HTML must load a stylesheet.");

  const [scriptResponse, stylesheetResponse] = await Promise.all([
    fetch(new URL(scriptPath, baseUrl)),
    fetch(new URL(stylesheetPath, baseUrl)),
  ]);
  assert.equal(scriptResponse.status, 200);
  assert.equal(stylesheetResponse.status, 200);
  assert.match(scriptResponse.headers.get("content-type") ?? "", /javascript/);
  assert.match(stylesheetResponse.headers.get("content-type") ?? "", /text\/css/);

  const sourceHtml = await readFile("dist/index.html", "utf8");
  assert.equal(html, sourceHtml);
  console.log("Production preview HTTP smoke passed.");
} finally {
  await server.close();
}
