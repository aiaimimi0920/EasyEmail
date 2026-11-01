import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderInstance } from "../../src/domain/models.js";
import {
  Im215ClientError,
  buildIm215StatusError,
  classifyIm215Error,
  extractDomainCandidates,
  extractMailboxPayload,
  extractMessageList,
  isSharedDomainRestrictionMessage,
  nextDomainRotationOffset,
  parseExactEmailAddress,
  readMessageHtml,
  readMessageSender,
  readString,
  requestJson,
  resolveIm215Config,
} from "../../src/providers/im215/protocol.js";
import { nextDomainRotationOffset as nextDomainRotationOffsetDirect }
  from "../../src/providers/im215/protocol-values.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("im215 protocol values", () => {
  it("preserves array text and nested sender representations", () => {
    expect(readString(["first", "second"])).toBe("first\nsecond");
    expect(readMessageHtml({ html: ["<p>first</p>", "<p>second</p>"] }))
      .toBe("<p>first</p>\n<p>second</p>");
    expect(readMessageSender({ sender: { email: " sender@example.test " } }))
      .toBe("sender@example.test");
  });

  it("filters unusable object domains while retaining string domains", () => {
    expect(extractDomainCandidates({
      data: [
        " RAW.EXAMPLE ",
        { domain: "enabled.example", active: true, dnsRecords: { receivingReady: true } },
        { domain: "disabled.example", status: "disabled" },
        { domain: "private.example", isPublic: false },
        { domain: "bad-mx.example", dnsRecords: { mxValid: false } },
        { domain: "ENABLED.EXAMPLE", enabled: true },
      ],
    })).toEqual(["raw.example", "enabled.example"]);
  });

  it("keeps one domain rotation state behind direct and facade imports", () => {
    const namespace = `test:im215:protocol:${Date.now()}`;

    expect(nextDomainRotationOffset(namespace, 3)).toBe(0);
    expect(nextDomainRotationOffsetDirect(namespace, 3)).toBe(1);
    expect(nextDomainRotationOffset(namespace, 3)).toBe(2);
  });

  it("unwraps nested mailbox and message payloads", () => {
    expect(extractMailboxPayload({ data: { mailbox: {
      id: "mailbox-1",
      email: " Demo@Example.Test ",
      created_at: "2026-09-04T00:00:00.000Z",
      tempToken: "temporary-token",
    } } })).toEqual({
      address: "demo@example.test",
      mailboxId: "mailbox-1",
      domain: undefined,
      createdAt: "2026-09-04T00:00:00.000Z",
      tempToken: "temporary-token",
    });
    expect(extractMessageList({ result: { messages: [{ id: "message-1" }] } }))
      .toEqual([{ id: "message-1" }]);
  });
});

describe("im215 protocol errors", () => {
  it("preserves classification precedence and shared-domain detection", () => {
    expect(classifyIm215Error("status 401 and rate limit")).toBe("auth");
    expect(classifyIm215Error("status 429 quota exhausted")).toBe("capacity");
    expect(classifyIm215Error("gateway status 503")).toBe("transient");
    expect(classifyIm215Error("invalid response shape")).toBe("provider");
    expect(isSharedDomainRestrictionMessage(
      "Shared domain is restricted and not accepting new public addresses",
    )).toBe(true);
  });

  it("retains status details and exact-address validation errors", () => {
    const statusError = buildIm215StatusError("getDomains", 403, { error: "Forbidden" });
    expect(statusError).toMatchObject({
      name: "Im215ClientError",
      kind: "auth",
      status: 403,
      message: "215.im getDomains failed with status 403. Forbidden",
    });
    expect(parseExactEmailAddress(" Demo@Example.Test ")).toEqual({
      address: "demo@example.test",
      localPart: "demo",
      domain: "example.test",
    });
    expect(() => parseExactEmailAddress("not-an-address")).toThrow(Im215ClientError);
  });
});

describe("im215 protocol config and transport", () => {
  it("resolves inline credentials and normalized defaults", () => {
    const config = resolveIm215Config(createInstance({
      apiKey: " inline-key ",
      domain: " Preferred.Example ",
      timeoutSeconds: "12",
    }));

    expect(config).toMatchObject({
      instanceId: "im215-test",
      namespace: "mail:im215:im215-test",
      apiBase: "https://maliapi.215.im/v1",
      preferredDomain: "Preferred.Example",
      timeoutSeconds: 12,
    });
    expect(config.credentialSets[0]?.items[0]?.value).toBe("inline-key");
  });

  it("encodes requests and decodes JSON responses", async () => {
    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ data: ["one.example"] }),
      { status: 200 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const config = resolveIm215Config(createInstance({ apiKey: "inline-key" }));

    await expect(requestJson(config, "api-key", "POST", "/domains", {
      query: { page: 2, search: "a b", omitted: undefined },
      jsonBody: { enabled: true },
    })).resolves.toEqual({ status: 200, body: { data: ["one.example"] } });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://maliapi.215.im/v1/domains?page=2&search=a%20b",
      expect.objectContaining({
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer api-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ enabled: true }),
      }),
    );
  });

  it("preserves text and empty response bodies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ status: 502, text: async () => "gateway text" })
      .mockResolvedValueOnce({ status: 204, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);
    const config = resolveIm215Config(createInstance({ apiKey: "inline-key" }));

    await expect(requestJson(config, "api-key", "GET", "/text"))
      .resolves.toEqual({ status: 502, body: "gateway text" });
    await expect(requestJson(config, "api-key", "GET", "/empty"))
      .resolves.toEqual({ status: 204, body: {} });
  });

  it("classifies network failures from the transport boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("fetch failed");
    }));
    const config = resolveIm215Config(createInstance({ apiKey: "inline-key" }));

    await expect(requestJson(config, "api-key", "GET", "/domains"))
      .rejects.toMatchObject({ name: "Im215ClientError", kind: "transient" });
  });
});

function createInstance(metadata: Record<string, string>): ProviderInstance {
  return {
    id: "im215-test",
    providerTypeKey: "im215",
    displayName: "215.im",
    status: "active",
    runtimeKind: "external",
    connectorKind: "api",
    shared: true,
    costTier: "free",
    healthScore: 1,
    averageLatencyMs: 100,
    connectionRef: "im215-test",
    hostBindings: [],
    groupKeys: ["im215"],
    metadata,
    createdAt: "2026-09-04T00:00:00.000Z",
    updatedAt: "2026-09-04T00:00:00.000Z",
  };
}
