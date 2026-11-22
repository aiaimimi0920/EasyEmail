import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultProviderInstances } from "../../src/defaults/provider_instances/index.js";
import { probeTemporamInstance, TemporamClient } from "../../src/providers/temporam/client.js";

afterEach(() => vi.unstubAllGlobals());

function instance(baseUrl: string, apiKey?: string) {
  const value = createDefaultProviderInstances(new Date()).find((item) => item.providerTypeKey === "temporam");
  if (!value) throw new Error("Missing Temporam fixture");
  return { ...value, metadata: { apiBase: baseUrl, ...(apiKey === undefined ? {} : { apiKey }) } };
}

describe("Temporam configuration failures", () => {
  it.each([
    ["https://api.temporam.com/v3", undefined],
    ["https://api.temporam.com/v3/", "   "],
  ])("fails without a network call for the official API at %s", async (baseUrl, key) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    await expect(TemporamClient.fromInstance(instance(baseUrl, key)).getDomains()).rejects.toThrow(
      "TEMPORAM_CONFIGURATION_FAILURE: Temporam API key is required for the official v3 API.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("records an actionable probe category without sending credentials or requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":[]}'));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeTemporamInstance(instance("https://api.temporam.com/v3"));
    expect(result).toMatchObject({
      ok: false, metadata: { errorClass: "configuration", state: "missing-api-key" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    "https://www.temporam.com", "https://custom.example/v3",
    "https://api.temporam.com/custom", "https://api.temporam.com:8443/v3",
  ])("preserves keyless compatibility for %s", async (baseUrl) => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"data":["mail.example"]}'));
    vi.stubGlobal("fetch", fetchMock);
    expect(await TemporamClient.fromInstance(instance(baseUrl)).getDomains()).toEqual(["mail.example"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel a supplied but rejected key as missing configuration", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await probeTemporamInstance(instance("https://api.temporam.com/v3", "fake-test-key"));
    expect(result.ok).toBe(false);
    expect(result.metadata?.errorClass).toBe("provider");
    expect(result.metadata?.state).toBeUndefined();
    expect(result.detail).not.toContain("fake-test-key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
