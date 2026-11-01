import { describe, expect, it } from "vitest";

import { EasyEmailHttpHandler } from "../../src/http/handler.js";
import { createEasyEmailHttpServer } from "../../src/http/server.js";
import { createEasyEmailService } from "../../src/service/easy-email-service.js";

const DESKTOP_ORIGIN = "http://tauri.localhost";

function preflightHeaders(
  origin: string,
  method = "GET",
  requestedHeaders = "authorization",
) {
  return {
    origin,
    "access-control-request-method": method,
    "access-control-request-headers": requestedHeaders,
  };
}

describe("HTTP server CORS boundary", () => {
  it("allows configured desktop preflight requests without weakening bearer authentication", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
      {
        apiKey: "cors-test-token",
        corsOrigins: [DESKTOP_ORIGIN],
      },
    );

    try {
      const preflight = await fetch(`${server.baseUrl}/mail/catalog`, {
        method: "OPTIONS",
        headers: preflightHeaders(DESKTOP_ORIGIN),
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe(DESKTOP_ORIGIN);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
      expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
      expect(preflight.headers.get("vary")).toContain("Origin");
      expect(await preflight.text()).toBe("");

      const createPreflight = await fetch(`${server.baseUrl}/mail/mailboxes/open`, {
        method: "OPTIONS",
        headers: preflightHeaders(DESKTOP_ORIGIN, "POST", "authorization, content-type"),
      });
      expect(createPreflight.status).toBe(204);
      expect(createPreflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(createPreflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("content-type");

      const unauthorized = await fetch(`${server.baseUrl}/mail/catalog`, {
        headers: { origin: DESKTOP_ORIGIN },
      });
      expect(unauthorized.status).toBe(401);
      expect(unauthorized.headers.get("access-control-allow-origin")).toBe(DESKTOP_ORIGIN);

      const authenticated = await fetch(`${server.baseUrl}/mail/catalog`, {
        headers: {
          origin: DESKTOP_ORIGIN,
          authorization: "Bearer cors-test-token",
        },
      });
      expect(authenticated.status).toBe(200);
      expect(authenticated.headers.get("access-control-allow-origin")).toBe(DESKTOP_ORIGIN);
    } finally {
      await server.close();
    }
  });

  it("rejects disallowed origins and leaves standalone servers closed to browser origins", async () => {
    const handler = new EasyEmailHttpHandler(createEasyEmailService());
    const corsServer = await createEasyEmailHttpServer(handler, {
      apiKey: "cors-test-token",
      corsOrigins: [DESKTOP_ORIGIN],
    });
    const standaloneServer = await createEasyEmailHttpServer(handler, {
      apiKey: "cors-test-token",
    });

    try {
      const disallowed = await fetch(`${corsServer.baseUrl}/mail/catalog`, {
        method: "OPTIONS",
        headers: preflightHeaders("https://attacker.example"),
      });
      expect(disallowed.status).toBe(403);
      expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
      expect(disallowed.headers.get("vary")).toContain("Origin");

      const standalone = await fetch(`${standaloneServer.baseUrl}/mail/catalog`, {
        method: "OPTIONS",
        headers: preflightHeaders(DESKTOP_ORIGIN),
      });
      expect(standalone.status).toBe(401);
      expect(standalone.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await Promise.all([corsServer.close(), standaloneServer.close()]);
    }
  });
});

describe("HTTP server request body boundary", () => {
  it("rejects oversized chunked JSON without making the server unavailable", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
      { maxRequestBodyBytes: 64 },
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('{"providerTypeKey":"'));
        controller.enqueue(encoder.encode("x".repeat(128)));
        controller.enqueue(encoder.encode('"}'));
        controller.close();
      },
    });

    try {
      const oversized = await fetch(`${server.baseUrl}/mail/mailboxes/open`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });
      expect(oversized.status).toBe(413);
      await expect(oversized.json()).resolves.toMatchObject({
        code: "REQUEST_BODY_TOO_LARGE",
      });

      const followUp = await fetch(`${server.baseUrl}/mail/catalog`);
      expect(followUp.status).toBe(200);
    } finally {
      await server.close();
    }
  });
});

describe("HTTP server authentication boundary", () => {
  it("keeps the sensitive snapshot unavailable when no API key is configured", async () => {
    const server = await createEasyEmailHttpServer(
      new EasyEmailHttpHandler(createEasyEmailService()),
    );

    try {
      const snapshot = await fetch(`${server.baseUrl}/mail/snapshot`);
      expect(snapshot.status).toBe(403);
      await expect(snapshot.json()).resolves.toMatchObject({
        code: "SNAPSHOT_AUTH_REQUIRED",
      });

      const catalog = await fetch(`${server.baseUrl}/mail/catalog`);
      expect(catalog.status).toBe(200);
    } finally {
      await server.close();
    }
  });

  it("refuses an unauthenticated non-loopback listener", async () => {
    const outcome = await Promise.resolve()
      .then(() => createEasyEmailHttpServer(
        new EasyEmailHttpHandler(createEasyEmailService()),
        { hostname: "0.0.0.0" },
      ))
      .then(
        (server) => ({ server }),
        (error: unknown) => ({ error }),
      );

    try {
      expect(outcome).toHaveProperty("error");
      if ("error" in outcome) {
        expect(outcome.error).toBeInstanceOf(TypeError);
        expect(String(outcome.error)).toContain("apiKey is required");
      }
    } finally {
      if ("server" in outcome) await outcome.server.close();
    }
  });
});
