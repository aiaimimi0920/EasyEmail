import { describe, expect, it, vi } from "vitest";
import { describeHttpFailure, reportHttpFailure } from "../../src/http/failure-diagnostic.js";

describe("HTTP failure diagnostics", () => {
  it("retains nested connection errors from Node fetch without logging secrets", () => {
    const secret = "do-not-log-this-credential";
    const socket = Object.assign(new Error(`connect https://user:${secret}@upstream.invalid`), {
      code: "ECONNRESET",
      address: "private-address",
    });
    const error = new TypeError("fetch failed", {
      cause: new AggregateError([socket, Object.assign(new Error(secret), { code: "ENETUNREACH" })]),
    });
    const result = describeHttpFailure("POST", "/mail/mailboxes/open", error);
    expect(result.causes.map((cause) => cause.code).filter(Boolean)).toEqual([
      "ECONNRESET", "ENETUNREACH",
    ]);
    expect(result.causes[0]?.fetchFailed).toBe(true);
    const serialized = JSON.stringify(result);
    for (const sensitive of [secret, "upstream.invalid", "private-address", "stack"]) {
      expect(serialized).not.toContain(sensitive);
    }
  });

  it("redacts session identifiers, query parameters and unknown error properties", () => {
    const result = describeHttpFailure("GET", "/mail/mailboxes/private-session/code?token=private-token", {
      name: "private-name", code: "PRIVATE_TOKEN", message: "private-message",
    });
    expect(result.route).toBe("/mail/mailboxes/:sessionId/code");
    expect(result.causes).toEqual([{ name: "Error", fetchFailed: false }]);
    expect(JSON.stringify(result)).not.toMatch(/private/i);
    expect(describeHttpFailure("secret-method", "/private-path", null)).toMatchObject({
      method: "OTHER", route: "other", causes: [],
    });
  });

  it("bounds aggregate errors and cycles, and tolerates throwing properties", () => {
    const cycle: { cause?: unknown; message: string } = { message: "fetch failed" };
    cycle.cause = cycle;
    expect(describeHttpFailure("POST", "/mail/mailboxes/send", cycle).causes).toHaveLength(1);
    const aggregate = new AggregateError(Array.from({ length: 100 }, () => new Error("ignored")));
    expect(describeHttpFailure("POST", "/mail/mailboxes/release", aggregate).causes).toHaveLength(8);
    const hostile = Object.defineProperty({}, "cause", { get() { throw new Error("secret"); } });
    expect(() => describeHttpFailure("GET", "/other", hostile)).not.toThrow();
  });

  it("does not interrupt the response when the logger or diagnostic input fails", () => {
    const logger = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("closed pipe"); });
    try {
      expect(() => reportHttpFailure("POST", "/mail/mailboxes/open", new Error())).not.toThrow();
      const proxy = Proxy.revocable([], {});
      proxy.revoke();
      expect(() => reportHttpFailure("GET", "/other", { errors: proxy.proxy })).not.toThrow();
    } finally {
      logger.mockRestore();
    }
  });

  it("classifies wrapped upstream status and deadline errors without copying their text", () => {
    const result = describeHttpFailure("POST", "/mail/mailboxes/open",
      new Error("Cloudflare Temp Email newAddress failed with status 429: secret-response-body"));
    expect(result.causes[0]?.upstreamStatus).toBe(429);
    expect(JSON.stringify(result)).not.toContain("secret-response-body");
    const timeout = describeHttpFailure("POST", "/mail/mailboxes/open",
      new Error("Cloudflare Temp Email request timed out after 30s."));
    expect(timeout.causes[0]?.timeoutReported).toBe(true);
  });
});
