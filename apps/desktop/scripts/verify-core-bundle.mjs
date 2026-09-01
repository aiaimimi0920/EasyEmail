import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const coreRoot = resolve(scriptDir, "..", "src-tauri", "resources", "core");
const manifest = JSON.parse(readFileSync(join(coreRoot, "runtime-manifest.json"), "utf8"));
const runtime = join(coreRoot, manifest.runtime);
const entry = join(coreRoot, manifest.entry);
const temporaryRoot = mkdtempSync(join(tmpdir(), "easyemail-desktop-core-"));
const stateDir = join(temporaryRoot, "state");
const configPath = join(temporaryRoot, "config.yaml");
const apiToken = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

function reservePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolvePort(port)));
    });
  });
}

async function waitForReady(baseUrl, child) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Bundled core exited during startup with code ${child.exitCode}.`);
    }
    try {
      const response = await fetch(`${baseUrl}/mail/catalog`, {
        headers: { authorization: `Bearer ${apiToken}` },
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) return;
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw new Error("Bundled core readiness timed out.");
}

let child;
try {
  const port = await reservePort();
  const normalizedStateDir = stateDir.replaceAll("\\", "/").replaceAll('"', '\\"');
  writeFileSync(
    configPath,
    `server:\n  host: 127.0.0.1\n  port: ${port}\n  apiKey: "${apiToken}"\nmaintenance:\n  enabled: false\npersistence:\n  enabled: true\n  driver: file\n  intervalMs: 1000\n  filePath: "${normalizedStateDir}/easy-email-state.json"\n`,
    "utf8",
  );
  child = spawn(runtime, [entry], {
    cwd: coreRoot,
    env: {
      ...process.env,
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: stateDir,
      EASY_EMAIL_RESET_STORE_ON_BOOT: "false",
    },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });

  await waitForReady(`http://127.0.0.1:${port}`, child);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/mail/catalog`);
  if (unauthorized.status !== 401) {
    throw new Error(`Expected unauthenticated catalog to return 401, got ${unauthorized.status}.`);
  }
  console.log("Bundled EasyEmail core authenticated readiness passed.");
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((resolveExit) => child.once("exit", resolveExit));
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
}
