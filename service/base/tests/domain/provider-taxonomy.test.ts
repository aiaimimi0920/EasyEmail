import { describe, expect, it } from "vitest";
import {
  CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY,
  isCloudflareTempEmailProviderKey,
  normalizeMailProviderTypeKey,
} from "../../src/domain/models.js";

describe("provider taxonomy", () => {
  it.each([
    "gptmail",
    "mailtm",
    "mail2925",
    "duckmail",
    "m2u",
    "moemail",
    "im215",
    "guerrillamail",
    "tempmail-lol",
    "temporam",
    "etempmail",
    CLOUDFLARE_TEMP_EMAIL_PROVIDER_KEY,
  ])("normalizes the supported provider key %s", (providerKey) => {
    expect(normalizeMailProviderTypeKey(` ${providerKey.toUpperCase()} `)).toBe(providerKey);
  });

  it("rejects missing and unsupported provider keys", () => {
    expect(normalizeMailProviderTypeKey(undefined)).toBeUndefined();
    expect(normalizeMailProviderTypeKey("   ")).toBeUndefined();
    expect(normalizeMailProviderTypeKey("unsupported-provider")).toBeUndefined();
  });

  it("recognizes Cloudflare temporary-email keys without accepting aliases", () => {
    expect(isCloudflareTempEmailProviderKey(" CLOUDFLARE_TEMP_EMAIL ")).toBe(true);
    expect(isCloudflareTempEmailProviderKey("cloudflare-temp-email")).toBe(false);
    expect(isCloudflareTempEmailProviderKey(undefined)).toBe(false);
  });
});
