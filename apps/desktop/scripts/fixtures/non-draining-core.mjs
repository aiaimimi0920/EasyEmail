import { readFileSync } from "node:fs";
import { createServer } from "node:http";

// Fixture for M9 forced-timeout shutdown acceptance:
// Becomes HTTP-ready with the host's per-spawn apiKey and bundled instance nonce,
// then intentionally ignores stdin shutdown commands and EOF so the Tauri host
// must exercise its bounded timeout + exact-child kill/wait fallback.
const configPath = process.env.EASY_EMAIL_CONFIG_PATH ?? "";
const configText = readFileSync(configPath, "utf8");
const portMatch = configText.match(/^\s*port:\s*(\d+)/m);
const apiKeyMatch = configText.match(/^\s*apiKey:\s*"([^"]+)"/m);
const port = Number(portMatch?.[1] ?? 0);
const apiKey = apiKeyMatch?.[1] ?? "";
const instanceNonce = process.env.EASY_EMAIL_BUNDLED_INSTANCE_NONCE ?? "";

if (!port || !apiKey) {
  process.exit(2);
}

process.stdin.resume();
process.stdin.on("data", () => {
  // Intentionally ignore graceful shutdown messages to trigger host timeout fallback.
});

const server = createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${apiKey}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ code: "UNAUTHORIZED" }));
    return;
  }
  const headers = { "content-type": "application/json" };
  if (instanceNonce) {
    headers["x-easyemail-bundled-nonce"] = instanceNonce;
  }
  res.writeHead(200, headers);
  res.end(JSON.stringify({ catalog: { providers: [] } }));
});

server.listen(port, "127.0.0.1");
setInterval(() => {}, 1_000);
