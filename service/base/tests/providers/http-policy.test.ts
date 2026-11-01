import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchProviderResource, fetchProviderResourceWithRecovery } from "../../src/providers/http-policy.js";

const PROVIDER_ROOT = fileURLToPath(new URL("../../src/providers", import.meta.url));

async function listTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) return listTypeScriptFiles(path);
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return nested.flat();
}

describe("provider HTTP policy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("overrides caller redirect preferences with fail-closed behavior", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchProviderResource("https://provider.example.test/resource", {
      method: "GET",
      redirect: "follow",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://provider.example.test/resource",
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("keeps provider adapters on the centralized no-redirect transport", async () => {
    const files = (await listTypeScriptFiles(PROVIDER_ROOT))
      .filter((path) => !path.endsWith("/http-policy.ts"));
    const violations: string[] = [];
    for (const path of files) {
      const source = await readFile(path, "utf8");
      if (/\bfetch\s*\(|\(\s*fetch\s+as\s+unknown\s+as/.test(source)) {
        violations.push(path.slice(PROVIDER_ROOT.length + 1).replaceAll("\\", "/"));
      }
      if (source.includes("requests.request(") && !source.includes("allow_redirects=False")) {
        violations.push(`${path.slice(PROVIDER_ROOT.length + 1)}:requests`);
      }
      if (source.includes("urllib.request.build_opener(") && !source.includes("NoRedirectHandler")) {
        violations.push(`${path.slice(PROVIDER_ROOT.length + 1)}:urllib`);
      }
    }

    expect(violations).toEqual([]);
  });
});

describe("opt-in provider connection recovery", () => {
  const networkError = (code: string) => new TypeError("fetch failed", {
    cause: Object.assign(new Error("upstream details must not be logged"), { code }),
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("retries an unsent JSON POST after connection establishment times out", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const expected = new Response("{}", { status: 200 });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(networkError("UND_ERR_CONNECT_TIMEOUT"))
      .mockResolvedValueOnce(expected);
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const init: RequestInit = {
      method: "POST", body: '{"diagnostic":true}',
      headers: { Authorization: "Bearer test-secret" }, signal: controller.signal,
      redirect: "follow",
    };
    expect(await fetchProviderResourceWithRecovery("https://provider.example.test/open", init)).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]).toEqual({ ...init, redirect: "error" });
      expect(call[1].signal).toBe(controller.signal);
    }
    expect(JSON.stringify(logger.mock.calls)).toContain("UND_ERR_CONNECT_TIMEOUT");
    expect(JSON.stringify(logger.mock.calls)).not.toMatch(/test-secret|provider\.example|upstream details/);
  });

  it.each(["GET", "HEAD"])("retries a %s transport disconnect once", async (method) => {
    const expected = new Response(null, { status: 200 });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(networkError("UND_ERR_SOCKET"))
      .mockResolvedValueOnce(expected);
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchProviderResourceWithRecovery("https://provider.example.test/mail", { method })).toBe(expected);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("never replays an ambiguous %s disconnect", async (method) => {
    const error = networkError("UND_ERR_SOCKET");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProviderResourceWithRecovery("https://provider.example.test/write", {
      method, body: "{}",
    })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after one retry and surfaces the second failure", async () => {
    const second = networkError("UND_ERR_CONNECT_TIMEOUT");
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(networkError("UND_ERR_CONNECT_TIMEOUT"))
      .mockRejectedValue(second);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProviderResourceWithRecovery("https://provider.example.test/mail")).rejects.toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not restart an expired caller deadline", async () => {
    const controller = new AbortController();
    const error = networkError("UND_ERR_CONNECT_TIMEOUT");
    const fetchMock = vi.fn(async () => { controller.abort(); throw error; });
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProviderResourceWithRecovery("https://provider.example.test/mail", {
      signal: controller.signal,
    })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not replay a one-shot request body", async () => {
    const error = networkError("UND_ERR_CONNECT_TIMEOUT");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    const body = new ReadableStream();
    await expect(fetchProviderResourceWithRecovery("https://provider.example.test/write", {
      method: "POST", body,
    })).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await body.cancel();
  });

  it("does not retry HTTP errors or unclassified transport errors", async () => {
    const response = new Response("upstream error", { status: 500 });
    const fetchMock = vi.fn().mockResolvedValue(response);
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchProviderResourceWithRecovery("https://provider.example.test/mail")).toBe(response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const error = networkError("ERR_TLS_CERT_ALTNAME_INVALID");
    fetchMock.mockReset().mockRejectedValue(error);
    await expect(fetchProviderResourceWithRecovery("https://provider.example.test/mail")).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves single-attempt behavior for providers that have not opted in", async () => {
    const error = networkError("UND_ERR_CONNECT_TIMEOUT");
    const fetchMock = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchProviderResource("https://provider.example.test/mail")).rejects.toBe(error);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["GET", "POST"])("handles a real dropped %s connection without duplicating writes", async (method) => {
    let received = 0;
    const server = createServer((request, response) => {
      received += 1;
      if (received === 1) request.socket.destroy();
      else response.end("recovered");
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const pending = fetchProviderResourceWithRecovery(`http://127.0.0.1:${address.port}/diagnostic`, {
        method, signal: AbortSignal.timeout(5000),
      });
      if (method === "GET") {
        expect(await (await pending).text()).toBe("recovered");
        expect(received).toBe(2);
      } else {
        await expect(pending).rejects.toThrow();
        expect(received).toBe(1);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
