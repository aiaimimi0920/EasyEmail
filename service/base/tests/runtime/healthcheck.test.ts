import { createServer, type RequestListener } from "node:http";
import { describe, expect, it } from "vitest";
import { checkReadiness } from "../../src/runtime/healthcheck.js";

async function withServer(handler: RequestListener, check: (port: number) => Promise<void>) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP address");
  try {
    await check(address.port);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("container readiness", () => {
  it("uses the catalog and configured bearer token with a wildcard bind", async () => {
    await withServer((request, response) => {
      expect(request.url).toBe("/mail/catalog");
      expect(request.headers.authorization).toBe("Bearer test-only-token");
      response.end(JSON.stringify({ catalog: { providerTypes: [] } }));
    }, async (port) => {
      await expect(checkReadiness({ hostname: "0.0.0.0", port, apiKey: "test-only-token" })).resolves.toBeUndefined();
    });
  });

  it.each([401, 503])("rejects HTTP %s without including response text", async (status) => {
    await withServer((_, response) => {
      response.statusCode = status;
      response.end("private upstream detail");
    }, async (port) => {
      await expect(checkReadiness({ hostname: "127.0.0.1", port })).rejects.toThrow("readiness_http_status");
    });
  });

  it.each([{}, { catalog: null }, { catalog: [] }])("rejects invalid catalog %j", async (body) => {
    await withServer((_, response) => response.end(JSON.stringify(body)), async (port) => {
      await expect(checkReadiness({ hostname: "127.0.0.1", port })).rejects.toThrow("readiness_invalid_catalog");
    });
  });

  it("bounds response size", async () => {
    await withServer((_, response) => response.end("x".repeat(256 * 1024 + 1)), async (port) => {
      await expect(checkReadiness({ hostname: "127.0.0.1", port })).rejects.toThrow("readiness_body_limit");
    });
  });

  it("times out a stalled local server", async () => {
    await withServer(() => undefined, async (port) => {
      await expect(checkReadiness({ hostname: "127.0.0.1", port, timeoutMs: 50 })).rejects.toThrow();
    });
  });

  it("does not follow a redirect with the bearer token", async () => {
    await withServer((_, response) => {
      response.writeHead(302, { location: "/redirect-target" });
      response.end();
    }, async (port) => {
      await expect(checkReadiness({ hostname: "127.0.0.1", port, apiKey: "test-only-token" })).rejects.toThrow();
    });
  });
});
