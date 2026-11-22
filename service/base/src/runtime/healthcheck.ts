import { pathToFileURL } from "node:url";

export interface ReadinessOptions {
  hostname: string;
  port: number;
  apiKey?: string;
  timeoutMs?: number;
}

const MAX_CATALOG_BYTES = 256 * 1024;

/** Check the authenticated local API without probing providers or reading mail. */
export async function checkReadiness(options: ReadinessOptions): Promise<void> {
  const host = options.hostname === "0.0.0.0" ? "127.0.0.1" : options.hostname;
  const hostname = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  const response = await fetch(`http://${hostname}:${options.port}/mail/catalog`, {
    headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
    signal: AbortSignal.timeout(options.timeoutMs ?? 4000),
    redirect: "error",
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("readiness_http_status");
  }
  if (!response.body) throw new Error("readiness_empty_body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_CATALOG_BYTES) {
        await reader.cancel();
        throw new Error("readiness_body_limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  if (!body?.catalog || typeof body.catalog !== "object" || Array.isArray(body.catalog)) {
    throw new Error("readiness_invalid_catalog");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { loadEasyEmailServiceRuntimeConfigFromEnvironment } = await import("./config.js");
    const config = await loadEasyEmailServiceRuntimeConfigFromEnvironment(process.env);
    await checkReadiness(config);
  } catch {
    // Docker retains health output: never include config, headers or response bodies.
    console.error("easy_email_readiness_failed");
    process.exitCode = 1;
  }
}
