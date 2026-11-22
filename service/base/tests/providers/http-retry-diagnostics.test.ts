import { createHash } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchProviderResourceWithRecovery } from "../../src/providers/http-policy.js";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function retry(url: string, provider?: Parameters<typeof fetchProviderResourceWithRecovery>[2]) {
  const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = Object.assign(new Error("secret-error"), { code: "ECONNRESET" });
  vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error).mockResolvedValue(new Response("{}")));
  await fetchProviderResourceWithRecovery(url, { headers: {Authorization: "Bearer secret-header"} }, provider);
  return JSON.parse(logger.mock.calls.at(-1)![0] as string);
}

describe("privacy-preserving upstream retry attribution", () => {
  it("records only the failed attempt duration, not the recovery duration", async () => {
    const clock = vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(135.9);
    const row = await retry("https://worker.example.test/private");
    expect(row.elapsedMs).toBe(35);
    expect(row.transportPhase).toBe("unknown");
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("does not mislabel a connect timeout as TCP-only", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const cause = Object.assign(new Error("private connect details"), { code: "UND_ERR_CONNECT_TIMEOUT" });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(new TypeError("fetch failed", { cause }))
      .mockResolvedValueOnce(new Response("{}")));
    await fetchProviderResourceWithRecovery("https://worker.example.test/private");
    const row = JSON.parse(logger.mock.calls[0]![0] as string);
    expect(row.transportPhase).toBe("connect_or_tls");
    expect(row.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(Number.isSafeInteger(row.elapsedMs)).toBe(true);
    expect(JSON.stringify(row)).not.toMatch(/private|worker\.example|connect details/);
  });

  it("keeps recovery when error message inspection throws", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = Object.defineProperty({ code: "ECONNRESET" }, "message", {
      get() { throw new Error("private getter failure"); },
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response("{}")));
    await fetchProviderResourceWithRecovery("https://worker.example.test/private");
    expect(JSON.parse(logger.mock.calls[0]![0] as string).transportPhase).toBe("unknown");
    expect(JSON.stringify(logger.mock.calls)).not.toContain("private");
  });

  it("bounds phase inspection for cyclic error causes", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = { code: "ECONNRESET", cause: undefined as unknown };
    error.cause = error;
    vi.stubGlobal("fetch", vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce(new Response("{}")));
    await fetchProviderResourceWithRecovery("https://worker.example.test/private");
    expect(JSON.parse(logger.mock.calls[0]![0] as string).transportPhase).toBe("unknown");
  });

  it("identifies a real pre-TLS FIN without logging socket details", async () => {
    const logger = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sockets = new Set<import("node:net").Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.once("data", () => socket.end());
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test address");
      await expect(fetchProviderResourceWithRecovery(`https://127.0.0.1:${address.port}/private`, {
        signal: AbortSignal.timeout(5000),
      })).rejects.toThrow();
      expect(logger).toHaveBeenCalledTimes(1);
      const row = JSON.parse(logger.mock.calls[0]![0] as string);
      expect(row).toMatchObject({ code: "ECONNRESET", transportPhase: "tls_handshake", attempt: 2 });
      expect(JSON.stringify(row)).not.toMatch(/127\.0\.0\.1|private|Client network socket/);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("logs a provider and stable origin reference without URL or secrets", async () => {
    const row = await retry("https://secret-user:secret-password@worker.example.test/secret-path?token=secret-query", "cloudflare_temp_email");
    expect(row).toMatchObject({
      event: "easy_email_upstream_retry", providerTypeKey: "cloudflare_temp_email",
      code: "ECONNRESET", attempt: 2,
      upstreamRef: createHash("sha256").update("https://worker.example.test").digest("hex").slice(0, 16),
    });
    expect(JSON.stringify(row)).not.toMatch(/secret-|worker\.example|https:/);
  });

  it("keeps the reference independent of path, query and userinfo", async () => {
    const first = await retry("https://u:p@worker.example.test/a?token=a");
    const second = await retry("https://worker.example.test/b?token=b");
    expect(first.upstreamRef).toBe(second.upstreamRef);
    expect(first.upstreamRef).toMatch(/^[0-9a-f]{16}$/);
    const other = await retry("https://other.example.test/b");
    expect(other.upstreamRef).not.toBe(first.upstreamRef);
  });

  it("omits unknown provider input and an invalid URL instead of logging them", async () => {
    const row = await retry("secret-invalid-url", "secret-provider" as never);
    expect(row.providerTypeKey).toBeUndefined();
    expect(row.upstreamRef).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain("secret");
  });
});
