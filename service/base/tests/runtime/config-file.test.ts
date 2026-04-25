import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  EASY_EMAIL_DEFAULT_CONFIG_PATH,
  EASY_EMAIL_DEFAULT_STATE_DIR,
  loadEasyEmailServiceRuntimeConfigFromEnvironment,
  parseEasyEmailServiceRuntimeConfig,
  resolveEasyEmailConfigPath,
  resolveEasyEmailStateDir,
  shouldResetEasyEmailStoreOnBoot,
} from "../../src/runtime/config.js";

describe("runtime YAML config contract", () => {
  it("resolves default config and state paths", () => {
    expect(resolveEasyEmailConfigPath({})).toBe(EASY_EMAIL_DEFAULT_CONFIG_PATH);
    expect(resolveEasyEmailStateDir({})).toBe(EASY_EMAIL_DEFAULT_STATE_DIR);
    expect(shouldResetEasyEmailStoreOnBoot({ EASY_EMAIL_RESET_STORE_ON_BOOT: "true" })).toBe(true);
  });

  it("derives persistence paths from state dir", () => {
    const config = parseEasyEmailServiceRuntimeConfig({}, { stateDir: "/data/easy-email" });

    expect(config.persistence.filePath).toBe(resolve("/data/easy-email", "state/easy-email-state.json"));
    expect(config.persistence.databasePath).toBe(resolve("/data/easy-email", "state/easy-email-state.sqlite3"));
  });

  it("loads YAML config from EASY_EMAIL_CONFIG_PATH", async () => {
    const folder = await mkdtemp(join(tmpdir(), "easy-email-config-test-"));
    const configPath = join(folder, "config.yaml");

    await writeFile(configPath, `server:
  host: 127.0.0.1
  port: 9090
strategy:
  providerStrategyModeId: available-first
providers:
  mail2925:
    account: demo@2925.com
    password: super-secret
    aliasSeparator: "_"
  cloudflare_temp_email:
    baseUrl: https://mail.example
`, "utf8");

    const loaded = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: "/tmp/easy-email-state",
    });

    expect(loaded.hostname).toBe("127.0.0.1");
    expect(loaded.port).toBe(9090);
    expect(loaded.mail2925.account).toBe("demo@2925.com");
    expect(loaded.mail2925.password).toBe("super-secret");
    expect(loaded.cloudflareTempEmail.baseUrl).toBe("https://mail.example");
    expect(loaded.persistence.filePath).toBe(resolve("/tmp/easy-email-state", "state/easy-email-state.json"));
  });

  it("loads custom routing profiles and health gates from YAML", async () => {
    const folder = await mkdtemp(join(tmpdir(), "easy-email-routing-profile-test-"));
    const configPath = join(folder, "config.yaml");

    await writeFile(configPath, `strategy:
  routingProfiles:
    - id: high-availability
      displayName: High Availability
      description: Prefer the healthiest providers.
      providerStrategyModeId: available-first
      providerSelections: [m2u, moemail, etempmail]
      healthGate:
        minimumHealthScore: 0.75
        maxConsecutiveFailures: 1
        recentFailureWindowMs: 900000
        recentFailurePenalty: 0.2
`, "utf8");

    const loaded = await loadEasyEmailServiceRuntimeConfigFromEnvironment({
      EASY_EMAIL_CONFIG_PATH: configPath,
      EASY_EMAIL_STATE_DIR: "/tmp/easy-email-state",
    });

    expect(loaded.routingProfiles).toEqual([
      expect.objectContaining({
        id: "high-availability",
        providerStrategyModeId: "available-first",
        providerSelections: ["m2u", "moemail", "etempmail"],
        healthGate: {
          minimumHealthScore: 0.75,
          maxConsecutiveFailures: 1,
          recentFailureWindowMs: 900000,
          recentFailurePenalty: 0.2,
        },
      }),
    ]);
  });
});
