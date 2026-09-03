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
