import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEasyEmailServiceRuntimeConfig } from "../../src/runtime/config.js";

describe("alias runtime config", () => {
  it("defaults alias email providers to an empty list", () => {
    const config = parseEasyEmailServiceRuntimeConfig({}, {
      stateDir: "/tmp/easy-email-state",
    });

    expect(config.aliasEmail).toEqual({
      providers: [],
    });
  });

  it("parses configured alias providers", () => {
    const config = parseEasyEmailServiceRuntimeConfig({
      aliasEmail: {
        providers: [
          {
            key: "ddg",
            enabled: true,
            apiBaseUrl: "https://example.invalid/ddg",
            tokens: ["alpha", "beta"],
            tokensText: "gamma\ndelta",
            tokensFile: "keys/ddg.txt",
            dailyLimit: 90,
            cooldownMs: 12345,
            stateFilePath: "alias/ddg-state.json",
          },
        ],
      },
    }, {
      stateDir: "/srv/easy-email",
    });

    expect(config.aliasEmail).toEqual({
      providers: [
        {
          key: "ddg",
          enabled: true,
          apiBaseUrl: "https://example.invalid/ddg",
          tokens: ["alpha", "beta"],
          tokensText: "gamma\ndelta",
          tokensFile: "keys/ddg.txt",
          dailyLimit: 90,
          cooldownMs: 12345,
          stateFilePath: resolve("/srv/easy-email", "alias/ddg-state.json"),
        },
      ],
    });
  });

  it("defaults DDG provider fields when omitted", () => {
    const config = parseEasyEmailServiceRuntimeConfig({
      aliasEmail: {
        providers: [
          {
            key: "ddg",
          },
        ],
      },
    }, {
      stateDir: "/tmp/easy-email-state",
    });

    expect(config.aliasEmail.providers).toEqual([
      {
        key: "ddg",
        enabled: true,
        apiBaseUrl: "https://quack.duckduckgo.com",
        tokens: undefined,
        tokensText: undefined,
        tokensFile: undefined,
        dailyLimit: 150,
        cooldownMs: 24 * 60 * 60 * 1000,
        stateFilePath: resolve("/tmp/easy-email-state", "state/ddg-alias-key-pool.json"),
      },
    ]);
  });

  it("rejects unknown alias providers", () => {
    expect(() => parseEasyEmailServiceRuntimeConfig({
      aliasEmail: {
        providers: [
          {
            key: "unknown-provider",
          },
        ],
      },
    })).toThrow("aliasEmail.providers[].key 'unknown-provider' is not supported.");
  });
});
