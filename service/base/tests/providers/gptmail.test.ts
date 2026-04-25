import { afterEach, describe, expect, it, vi } from "vitest";
import type { CredentialSetDefinition } from "../../src/shared/index.js";
import { clearCredentialRuntimeState } from "../../src/shared/index.js";
import { probeGptMailInstance } from "../../src/providers/gptmail/client.js";

describe("gptmail provider", () => {
  afterEach(() => {
    clearCredentialRuntimeState();
    vi.restoreAllMocks();
  });

  it("treats generate-email as the probe path and succeeds when any key can open", async () => {
    const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
      const apiKey = String((init?.headers as Record<string, string> | undefined)?.["X-API-Key"] ?? "");
      if (apiKey === "bad-key") {
        return new Response('{"success":false,"error":"Invalid API key"}', { status: 401 });
      }
      if (apiKey === "quota-key") {
        return new Response('{"success":false,"error":"Daily quota exceeded"}', { status: 429 });
      }
      return new Response('{"success":true,"data":{"email":"probe@example-mail.test"}}', { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const credentialSets: CredentialSetDefinition[] = [{
      id: "test-set",
      displayName: "Test Set",
      useCases: ["generate", "poll"],
      strategy: "round-robin",
      priority: 100,
      items: [
        { id: "bad-key", label: "bad-key", value: "bad-key", priority: 300, metadata: {} },
        { id: "quota-key", label: "quota-key", value: "quota-key", priority: 200, metadata: {} },
        { id: "good-key", label: "good-key", value: "good-key", priority: 100, metadata: {} },
      ],
      metadata: {},
    }];

    const probe = await probeGptMailInstance({
      id: "gptmail-default",
      providerTypeKey: "gptmail",
      displayName: "GPT Mail Default",
      status: "active",
      runtimeKind: "external",
      connectorKind: "gptmail-connector",
      shared: true,
      costTier: "free",
      healthScore: 1,
      averageLatencyMs: 0,
      connectionRef: "external://gptmail/default",
      hostBindings: [],
      groupKeys: [],
      metadata: {
        baseUrl: "https://mail.chatgpt.org.uk",
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }, credentialSets);

    expect(probe.ok).toBe(true);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://mail.chatgpt.org.uk/api/generate-email",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "bad-key",
        }),
        body: "{}",
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://mail.chatgpt.org.uk/api/generate-email",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-API-Key": "good-key",
        }),
        body: "{}",
      }),
    );
  });
});
