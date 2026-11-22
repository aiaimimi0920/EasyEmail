import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createBundledCoreClient } from "../src/api/bundledCoreClient.ts";
import type { InvokeCommand } from "../src/api/invokeCommand.ts";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = resolve(TEST_DIR, "../src");
const CANARY_TOKEN = "canary-loopback-secret-99887766554433221100aabbccddeeff";
const ROTATED_TOKEN = "rotated-loopback-secret-11223344556677889900ffeeddccbbaa";
const HOST_ID = "easyemail-desktop-00000000000000000000000000000099";

test("loopback api_token stays isolated inside transport closure and never leaks to storage, URLs, or logs", async () => {
  const storageWrites: Array<{ bucket: string; key: string; value: string }> = [];
  const createTrapStorage = (bucket: string): Storage =>
    ({
      length: 0,
      clear() {},
      getItem() {
        return null;
      },
      key() {
        return null;
      },
      removeItem() {},
      setItem(key: string, value: string) {
        storageWrites.push({ bucket, key, value });
      },
    }) as Storage;

  const previousLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const previousSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: createTrapStorage("localStorage"),
  });
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    value: createTrapStorage("sessionStorage"),
  });

  const capturedLogs: string[] = [];
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  const originalConsoleLog = console.log;
  console.error = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
  console.warn = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));
  console.log = (...args: unknown[]) => capturedLogs.push(args.map(String).join(" "));

  try {
    const requestedUrls: string[] = [];
    const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
    let runtimeGeneration = 0;

    const invokeCommand: InvokeCommand = async <T>(command, args) => {
      invokeCalls.push({ command, args });
      if (command === "desktop_export_diagnostics") {
        return {
          bundle_path: "C:/temp/nmail-diagnostics-test.json",
          generated_at_epoch_ms: 1700000000000,
          included_log_files: 1,
          redacted_line_count: 12,
        } as T;
      }
      runtimeGeneration += 1;
      return {
        status: "ready",
        base_url:
          runtimeGeneration === 1 ? "http://127.0.0.1:43101" : "http://127.0.0.1:43102",
        api_token: runtimeGeneration === 1 ? CANARY_TOKEN : ROTATED_TOKEN,
        host_id: HOST_ID,
      } as T;
    };

    let simulateConnectionReset = false;
    const seenAuthHeaders: Array<string | null> = [];
    const fetchRequest: typeof fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      seenAuthHeaders.push(new Headers(init?.headers).get("authorization"));
      if (simulateConnectionReset) {
        simulateConnectionReset = false;
        throw new TypeError("fetch failed: ECONNREFUSED");
      }
      return new Response(JSON.stringify({ catalog: { providers: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createBundledCoreClient(invokeCommand, fetchRequest);
    assert.equal(await client.getHostId(), HOST_ID);
    await client.getCatalog();

    // Verify object surface and serialized representation never expose api_token
    const serializedClient = JSON.stringify(client);
    assert.equal(serializedClient.includes(CANARY_TOKEN), false);
    assert.equal("api_token" in (client as Record<string, unknown>), false);
    assert.equal("bearerToken" in (client as Record<string, unknown>), false);

    // Simulate child crash/restart: transport rejection evicts cached session so next call re-discovers rotated runtime
    simulateConnectionReset = true;
    await assert.rejects(client.getCatalog(), /ECONNREFUSED/);
    await client.getCatalog();
    assert.deepEqual(seenAuthHeaders, [
      `Bearer ${CANARY_TOKEN}`,
      `Bearer ${CANARY_TOKEN}`,
      `Bearer ${ROTATED_TOKEN}`,
    ]);
    assert.equal(requestedUrls[2], "http://127.0.0.1:43102/mail/catalog");

    const bundle = await client.exportDiagnostics("C:/temp/custom-diag");
    assert.equal(bundle.included_log_files, 1);
    assert.deepEqual(invokeCalls.at(-1), {
      command: "desktop_export_diagnostics",
      args: { request: { destination_dir: "C:/temp/custom-diag" } },
    });

    assert.equal(
      requestedUrls.some((url) => url.includes(CANARY_TOKEN) || url.includes(ROTATED_TOKEN)),
      false,
    );
    assert.equal(
      storageWrites.some(
        (entry) => entry.value.includes(CANARY_TOKEN) || entry.value.includes(ROTATED_TOKEN),
      ),
      false,
    );
    assert.equal(
      capturedLogs.some((line) => line.includes(CANARY_TOKEN) || line.includes(ROTATED_TOKEN)),
      false,
    );
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
    console.log = originalConsoleLog;
    if (previousLocalStorage) {
      Object.defineProperty(globalThis, "localStorage", previousLocalStorage);
    }
    if (previousSessionStorage) {
      Object.defineProperty(globalThis, "sessionStorage", previousSessionStorage);
    }
  }
});

test("renderer source files never persist api_token to web storage or URL parameters", () => {
  const bundledSource = readFileSync(resolve(SRC_ROOT, "api/bundledCoreClient.ts"), "utf8");
  const desktopCoreSource = readFileSync(resolve(SRC_ROOT, "api/desktopCoreClient.ts"), "utf8");
  for (const source of [bundledSource, desktopCoreSource]) {
    assert.equal(/localStorage|sessionStorage|document\.cookie/.test(source), false);
    assert.equal(/searchParams\.set\([^)]*token/i.test(source), false);
  }
});
